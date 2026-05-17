"""Integration tests for the /camera/upload + /camera/wait long-poll loop.

Runs without uvicorn via FastAPI's TestClient. Stubs out the optional
`render` import (pulls trimesh/pyrender which we don't need here) so the
server module imports cleanly in minimal envs.

Run:
    cd cad-coder/zeroentropy && /path/to/python -m pytest test_camera_wait.py -v
or:
    /path/to/python cad-coder/zeroentropy/test_camera_wait.py
"""
from __future__ import annotations

import asyncio
import io
import os
import sys
import tempfile
import threading
import time
import types
import unittest
from pathlib import Path


def _install_render_stub() -> None:
    """The server imports `render.VIEWS`. Stub it so heavy deps are optional."""
    if "render" in sys.modules:
        return
    stub = types.ModuleType("render")
    stub.VIEWS = ("iso", "front", "top", "right")
    sys.modules["render"] = stub


def _load_server_with_tempdir() -> tuple[object, Path]:
    """Import (or reload) the server module with a fresh CAMERA_DIR."""
    tmp = Path(tempfile.mkdtemp(prefix="camera-wait-test-"))
    os.environ["CAD_CAMERA_DIR"] = str(tmp)

    here = Path(__file__).resolve().parent
    if str(here) not in sys.path:
        sys.path.insert(0, str(here))
    _install_render_stub()

    # Force a fresh module each test so the in-memory session table starts empty
    # and CAMERA_DIR picks up the new env var.
    sys.modules.pop("server", None)
    import server  # noqa: WPS433 — deliberate late import after env mutation

    server.CAMERA_DIR = tmp
    server._camera_sessions.clear()
    server._camera_events.clear()
    return server, tmp


class CameraWaitTests(unittest.TestCase):
    def setUp(self) -> None:
        self.server, self.camera_dir = _load_server_with_tempdir()
        from fastapi.testclient import TestClient  # local import for fast collection
        self.client = TestClient(self.server.app)

    def _upload(self, session: str = "TEST", body: bytes = b"\xff\xd8jpeg-bytes") -> dict:
        files = {"file": ("photo.jpg", io.BytesIO(body), "image/jpeg")}
        r = self.client.post(f"/camera/upload?session={session}", files=files)
        self.assertEqual(r.status_code, 200, r.text)
        return r.json()

    def test_wait_returns_immediately_when_image_already_present(self) -> None:
        self._upload("AAAA")
        r = self.client.get("/camera/wait?session=AAAA&since=0&timeout_s=5")
        self.assertEqual(r.status_code, 200)
        body = r.json()
        self.assertEqual(body["status"], "image_received")
        self.assertEqual(body["session"], "AAAA")
        self.assertGreater(body["size_bytes"], 0)
        self.assertTrue(body["path"].endswith("AAAA.jpg"))

    def test_wait_times_out_when_no_image(self) -> None:
        started = time.monotonic()
        r = self.client.get("/camera/wait?session=BBBB&since=0&timeout_s=0.4")
        elapsed = time.monotonic() - started
        self.assertEqual(r.status_code, 200)
        body = r.json()
        self.assertEqual(body["status"], "timeout")
        self.assertEqual(body["session"], "BBBB")
        self.assertGreaterEqual(elapsed, 0.3)
        self.assertLess(elapsed, 2.0)

    def test_wait_wakes_on_upload(self) -> None:
        """A waiter blocked on an empty session must return the moment the
        upload handler signals the event — not after the full timeout."""
        # Start the waiter in a background thread so we can upload from the
        # main thread mid-wait. TestClient is sync, so threads are the simple path.
        results: dict[str, object] = {}

        def waiter() -> None:
            t0 = time.monotonic()
            r = self.client.get("/camera/wait?session=CCCC&since=0&timeout_s=10")
            results["elapsed"] = time.monotonic() - t0
            results["status"] = r.status_code
            results["body"] = r.json()

        t = threading.Thread(target=waiter, daemon=True)
        t.start()
        # Give the waiter a beat to actually start its long-poll.
        time.sleep(0.3)
        self._upload("CCCC")
        t.join(timeout=5)
        self.assertFalse(t.is_alive(), "waiter did not return within 5s of upload")
        self.assertEqual(results["status"], 200)
        body = results["body"]
        assert isinstance(body, dict)
        self.assertEqual(body["status"], "image_received")
        self.assertEqual(body["session"], "CCCC")
        # Wake latency: should be well under a second even on a loaded box.
        elapsed = results["elapsed"]
        assert isinstance(elapsed, float)
        self.assertLess(elapsed, 3.0, f"wake latency too slow: {elapsed}s")

    def test_wait_filters_by_since(self) -> None:
        """`since=<received_at>` of an existing upload should make /camera/wait
        block (or time out) instead of re-firing on the stale image."""
        upload = self._upload("DDDD")
        first_status = self.client.get("/camera/status?session=DDDD").json()
        since = float(first_status["received_at"])
        # Wait with since=current — no NEW upload, expect timeout.
        r = self.client.get(f"/camera/wait?session=DDDD&since={since}&timeout_s=0.4")
        self.assertEqual(r.status_code, 200)
        self.assertEqual(r.json()["status"], "timeout")
        # Sanity: with since=0 we still get the upload.
        r2 = self.client.get("/camera/wait?session=DDDD&since=0&timeout_s=1")
        self.assertEqual(r2.json()["status"], "image_received")
        # Quiet the lint about the unused first-upload result.
        self.assertTrue(upload["ok"])

    def test_invalid_session(self) -> None:
        r = self.client.get("/camera/wait?session=bad code!&since=0&timeout_s=0")
        self.assertEqual(r.status_code, 400)

    def test_timeout_zero_returns_current_state(self) -> None:
        # No upload yet: timeout_s=0 should return the timeout status.
        r = self.client.get("/camera/wait?session=EEEE&since=0&timeout_s=0")
        self.assertEqual(r.json()["status"], "timeout")
        # With an upload: timeout_s=0 returns it immediately.
        self._upload("EEEE")
        r2 = self.client.get("/camera/wait?session=EEEE&since=0&timeout_s=0")
        self.assertEqual(r2.json()["status"], "image_received")


if __name__ == "__main__":
    # Allow `python test_camera_wait.py` to run the suite without pytest.
    unittest.main(verbosity=2)
