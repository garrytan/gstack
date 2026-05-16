# Thingiverse → ZeroEntropy retrieval pipeline

Natural-language search over Thingiverse STL files. Scrapes ~100 popular models,
indexes their descriptions into a [ZeroEntropy](https://zeroentropy.dev) hosted
collection, and answers free-text queries with a matching STL URL.

## Files

- `scrape.py` — Thingiverse API → `models.jsonl` (one record per thing)
- `index.py` — `models.jsonl` → ZeroEntropy collection
- `query.py` — CLI: natural-language query → top STL URL (kept for debugging)
- `server.py` — FastAPI service exposing `GET /query` for the `/stl-search` skill
- `.env.example` — required environment variables

## Setup

1. Install deps:
   ```bash
   pip install -r requirements.txt
   ```

2. Get a Thingiverse API token (free): https://www.thingiverse.com/developers/my-apps
   Register an app, copy the **App Token**.

3. Get a ZeroEntropy API key: https://dashboard.zeroentropy.dev

4. Copy `.env.example` to `.env` and fill in both values.

## Run

```bash
# 1. scrape 100 popular things (~1-2 min, ~30 API calls + per-thing detail calls)
python scrape.py --count 100

# 2. push to ZE (creates the collection if missing)
python index.py

# 3. wait ~30s for ZE indexing, then start the API
uvicorn server:app --port 8000

# 4. query it (top 3, STLs downloaded + cached, paths returned)
curl -sS "http://127.0.0.1:8000/query?q=low-poly+fox&k=3" | jq

# or use the CLI directly for debugging
python query.py "a phone stand that holds a tablet"
```

The `/stl-search` gstack skill talks to the server on `127.0.0.1:8000`.

## How it works

- Each Thingiverse "thing" becomes one ZE document. Indexed text is
  `name + tags + description + details` (HTML stripped).
- Per-thing metadata carries `thing_url`, `stl_url` (the first STL file),
  and `all_stl_urls`. Retrieval returns these so the caller has a direct
  path to the file.
- "URLs only" by design — STL files are not downloaded. If you want
  on-disk paths, add a lazy downloader keyed off `stl_url`.

## Tuning

- Bump `--count` in `scrape.py` to grow the corpus.
- Edit `build_text()` in `index.py` to change what gets embedded.
- `query.py --json` dumps the full ZE response for debugging.
