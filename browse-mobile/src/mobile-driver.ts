/**
 * MobileDriver — Pure HTTP Appium client (zero npm dependencies)
 *
 * Uses the W3C WebDriver protocol directly via fetch() instead of webdriverio.
 * This avoids bundling issues with webdriverio's transitive dependencies.
 */

import { parseXmlToRefs, resolveRef, snapshotDiff, type MobileRefEntry } from "./ref-system";
import { ensureBootedSimulator } from "./platform/ios";
import * as fs from "fs";
import * as path from "path";

const APPIUM_BASE = "http://127.0.0.1:4723";
const REQUEST_TIMEOUT = 30000; // 30s per command
const SESSION_TIMEOUT = 180000; // 3 min for session creation (WDA build)

export interface MobileDriverOptions {
  bundleId: string;
  appPath?: string;
  automationName?: string;
  platformVersion?: string;
  deviceName?: string;
}

// ─── Raw Appium HTTP Client ───

async function appiumPost(
  sessionId: string,
  endpoint: string,
  body?: Record<string, unknown>,
  timeout = REQUEST_TIMEOUT,
): Promise<unknown> {
  const url = `${APPIUM_BASE}/session/${sessionId}${endpoint}`;
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: body ? JSON.stringify(body) : "{}",
    signal: AbortSignal.timeout(timeout),
  });
  const data = (await res.json()) as { value: unknown };
  if (!res.ok) {
    const err = data.value as { message?: string } | string;
    const msg = typeof err === "string" ? err : (err as { message?: string })?.message || JSON.stringify(err);
    throw new Error(`Appium error: ${msg}`);
  }
  return data.value;
}

async function appiumGet(
  sessionId: string,
  endpoint: string,
  timeout = REQUEST_TIMEOUT,
): Promise<unknown> {
  const url = `${APPIUM_BASE}/session/${sessionId}${endpoint}`;
  const res = await fetch(url, {
    signal: AbortSignal.timeout(timeout),
  });
  const data = (await res.json()) as { value: unknown };
  if (!res.ok) {
    const err = data.value as { message?: string } | string;
    const msg = typeof err === "string" ? err : (err as { message?: string })?.message || JSON.stringify(err);
    throw new Error(`Appium error: ${msg}`);
  }
  return data.value;
}

async function appiumDelete(
  sessionId: string,
  timeout = REQUEST_TIMEOUT,
): Promise<void> {
  const url = `${APPIUM_BASE}/session/${sessionId}`;
  await fetch(url, {
    method: "DELETE",
    signal: AbortSignal.timeout(timeout),
  });
}

// Find element helper — returns element ID or null
// Returns null only for "element not found" (W3C NoSuchElement); rethrows other errors
async function findElement(
  sessionId: string,
  using: string,
  value: string,
): Promise<string | null> {
  try {
    const result = (await appiumPost(sessionId, "/element", { using, value })) as Record<string, string>;
    // W3C returns { "element-xxx": "id" } or { ELEMENT: "id" }
    return result["element-6066-11e4-a52e-4f735466cecf"] || result["ELEMENT"] || Object.values(result)[0] || null;
  } catch (err) {
    // W3C "no such element" is expected — return null
    const msg = err instanceof Error ? err.message : String(err);
    if (msg.includes("no such element") || msg.includes("NoSuchElement") || msg.includes("unable to find")) {
      return null;
    }
    // Rethrow unexpected errors (network, timeout, invalid session)
    throw err;
  }
}

// ─── Pointer Action Helpers ───

function tapAction(x: number, y: number) {
  return {
    actions: [{
      type: "pointer", id: "finger1",
      parameters: { pointerType: "touch" },
      actions: [
        { type: "pointerMove", duration: 0, x: Math.round(x), y: Math.round(y) },
        { type: "pointerDown", button: 0 },
        { type: "pointerUp", button: 0 },
      ],
    }],
  };
}

function swipeAction(startX: number, startY: number, endX: number, endY: number, durationMs = 300) {
  return {
    actions: [{
      type: "pointer", id: "finger1",
      parameters: { pointerType: "touch" },
      actions: [
        { type: "pointerMove", duration: 0, x: startX, y: startY },
        { type: "pointerDown", button: 0 },
        { type: "pointerMove", duration: durationMs, x: endX, y: endY },
        { type: "pointerUp", button: 0 },
      ],
    }],
  };
}

// ─── MobileDriver ───

export class MobileDriver {
  private sessionId: string | null = null;
  private refs: Map<string, MobileRefEntry> = new Map();
  private lastSnapshot: string | null = null;
  private options: MobileDriverOptions;
  private _isConnected = false;

  constructor(options: MobileDriverOptions) {
    this.options = options;
  }

  async connect(): Promise<void> {
    const sim = ensureBootedSimulator();
    if (!sim) {
      throw new Error("No iOS Simulator available. Run: xcrun simctl list devices available");
    }

    const capabilities: Record<string, unknown> = {
      platformName: "iOS",
      "appium:automationName": this.options.automationName || "XCUITest",
      "appium:deviceName": this.options.deviceName || sim.name,
      "appium:udid": sim.udid,
      "appium:bundleId": this.options.bundleId,
      "appium:autoAcceptAlerts": true,
      "appium:noReset": true,
      "appium:newCommandTimeout": 1800,
      "appium:wdaLaunchTimeout": 120000,
      "appium:wdaConnectionTimeout": 120000,
    };

    if (this.options.appPath) {
      capabilities["appium:app"] = this.options.appPath;
    }
    if (this.options.platformVersion) {
      capabilities["appium:platformVersion"] = this.options.platformVersion;
    }

    // Create session via raw HTTP (long timeout for WDA compilation)
    const res = await fetch(`${APPIUM_BASE}/session`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        capabilities: { alwaysMatch: capabilities, firstMatch: [{}] },
      }),
      signal: AbortSignal.timeout(SESSION_TIMEOUT),
    });

    if (!res.ok) {
      const errText = await res.text();
      throw new Error(`Appium session creation failed (${res.status}): ${errText}`);
    }

    const data = (await res.json()) as {
      value: { sessionId: string; capabilities: Record<string, unknown> };
    };
    this.sessionId = data.value.sessionId;
    this._isConnected = true;
  }

  async disconnect(): Promise<void> {
    if (this.sessionId) {
      try {
        await appiumDelete(this.sessionId);
      } catch { /* session may already be dead */ }
      this.sessionId = null;
    }
    this._isConnected = false;
    this.refs.clear();
    this.lastSnapshot = null;
  }

  get isConnected(): boolean {
    return this._isConnected && this.sessionId !== null;
  }

  async isHealthy(): Promise<boolean> {
    if (!this.sessionId) return false;
    try {
      await appiumGet(this.sessionId, "/source", 5000);
      return true;
    } catch {
      return false;
    }
  }

  private ensureSession(): string {
    if (!this.sessionId) {
      throw new Error("Not connected to Appium. Call connect() first.");
    }
    return this.sessionId;
  }

  // ─── Ref Map ───

  setRefMap(refs: Map<string, MobileRefEntry>): void { this.refs = refs; }
  getRefCount(): number { return this.refs.size; }
  clearRefs(): void { this.refs.clear(); }
  setLastSnapshot(text: string | null): void { this.lastSnapshot = text; }
  getLastSnapshot(): string | null { return this.lastSnapshot; }

  // ─── Commands ───

  async goto(target: string): Promise<string> {
    const sid = this.ensureSession();

    if (target.startsWith("app://")) {
      const bundleId = target.replace("app://", "");
      try {
        await appiumPost(sid, "/execute/sync", {
          script: "mobile: terminateApp",
          args: [{ bundleId }],
        });
      } catch { /* app may not be running */ }
      await appiumPost(sid, "/execute/sync", {
        script: "mobile: launchApp",
        args: [{ bundleId }],
      });
      return `Launched ${bundleId}`;
    }

    // Deep link
    try {
      await appiumPost(sid, "/url", { url: target });
      return `Navigated to ${target}`;
    } catch (err) {
      return `Deep link failed: ${err instanceof Error ? err.message : String(err)}. Navigate manually via click commands.`;
    }
  }

  async click(refOrSelector: string): Promise<string> {
    const sid = this.ensureSession();

    if (refOrSelector.startsWith("@")) {
      const finder = async (strategy: string, selector: string) => {
        const using = strategy === "accessibility id" ? "accessibility id" : "xpath";
        return findElement(sid, using, selector);
      };

      let result = await resolveRef(refOrSelector, this.refs, finder);

      if (!result) {
        // Auto-refresh snapshot and retry
        await this.snapshot([]);
        result = await resolveRef(refOrSelector, this.refs, finder);
        if (!result) {
          throw new Error(`Element ${refOrSelector} no longer exists — screen may have navigated`);
        }
      }

      return this.performClick(sid, result);
    }

    // Direct selector: try as accessibility label
    // Supports both ~Label and label:Label syntax (label: preferred to avoid shell ~ expansion)
    const labelMatch = refOrSelector.match(/^(?:~|label:)(.+)$/);
    if (labelMatch) {
      const label = labelMatch[1].replace(/^["']|["']$/g, ""); // strip quotes
      const elementId = await findElement(sid, "accessibility id", label);
      if (elementId) {
        await appiumPost(sid, `/element/${elementId}/click`);
        return `Clicked label:${label}`;
      }
      throw new Error(`Element with accessibility label "${label}" not found`);
    }

    const elementId = await findElement(sid, "xpath", refOrSelector);
    if (elementId) {
      await appiumPost(sid, `/element/${elementId}/click`);
      return `Clicked ${refOrSelector}`;
    }
    throw new Error(`Element not found: ${refOrSelector}`);
  }

  private async performClick(
    sid: string,
    result: { element: unknown; usedCoordinates: boolean },
  ): Promise<string> {
    if (result.usedCoordinates) {
      const coords = result.element as { x: number; y: number };
      await appiumPost(sid, "/actions", tapAction(coords.x, coords.y));
      return `Tapped at (${Math.round(coords.x)}, ${Math.round(coords.y)}) — coordinate fallback. Consider adding accessibilityLabel.`;
    }

    const elementId = result.element as string;
    await appiumPost(sid, `/element/${elementId}/click`);

    const refKey = [...this.refs.entries()].find(([, e]) => e.label);
    const label = refKey ? ` (${refKey[1].elementType.replace("XCUIElementType", "")}: "${refKey[1].label}")` : "";
    return `Clicked${label}`;
  }

  async tapCoordinates(x: number, y: number): Promise<string> {
    const sid = this.ensureSession();
    await appiumPost(sid, "/actions", tapAction(x, y));
    return `Tapped at (${x}, ${y})`;
  }

  async fill(refOrSelector: string, text: string): Promise<string> {
    const sid = this.ensureSession();

    if (refOrSelector.startsWith("@")) {
      const finder = async (strategy: string, selector: string) => {
        const using = strategy === "accessibility id" ? "accessibility id" : "xpath";
        return findElement(sid, using, selector);
      };

      const result = await resolveRef(refOrSelector, this.refs, finder);
      if (!result) {
        throw new Error(`Cannot fill ${refOrSelector} — element not found`);
      }

      if (result.usedCoordinates) {
        // Tap to focus, then type via keyboard actions
        const coords = result.element as { x: number; y: number };
        await appiumPost(sid, "/actions", tapAction(coords.x, coords.y));
        await new Promise((r) => setTimeout(r, 500));
        // Type via key actions
        const keyActions: Array<{ type: string; value?: string }> = [];
        for (const char of text) {
          keyActions.push({ type: "keyDown", value: char });
          keyActions.push({ type: "keyUp", value: char });
        }
        await appiumPost(sid, "/actions", {
          actions: [{ type: "key", id: "keyboard", actions: keyActions }],
        });
        return `Filled ${refOrSelector} with "${text}" (via coordinate tap + keyboard)`;
      }

      const elementId = result.element as string;
      await appiumPost(sid, `/element/${elementId}/clear`);
      await appiumPost(sid, `/element/${elementId}/value`, { text });
      return `Filled ${refOrSelector} with "${text}"`;
    }

    // Direct selector
    const elementId = await findElement(sid, "accessibility id", refOrSelector.replace(/^~/, ""));
    if (!elementId) throw new Error(`Element not found: ${refOrSelector}`);
    await appiumPost(sid, `/element/${elementId}/clear`);
    await appiumPost(sid, `/element/${elementId}/value`, { text });
    return `Filled ${refOrSelector} with "${text}"`;
  }

  async screenshot(outputPath: string): Promise<string> {
    const sid = this.ensureSession();
    const base64 = (await appiumGet(sid, "/screenshot")) as string;
    const buffer = Buffer.from(base64, "base64");

    try {
      const dir = path.dirname(outputPath);
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(outputPath, buffer);
    } catch (err) {
      throw new Error(`Screenshot save failed: ${err instanceof Error ? err.message : String(err)}. Disk may be full.`);
    }

    return `Screenshot saved to ${outputPath} (${buffer.length} bytes)`;
  }

  async snapshot(flags: string[]): Promise<string> {
    const sid = this.ensureSession();
    const xml = (await appiumGet(sid, "/source")) as string;
    const result = parseXmlToRefs(xml);

    this.refs = result.refs;
    const isDiff = flags.includes("-D") || flags.includes("--diff");
    const isAnnotate = flags.includes("-a") || flags.includes("--annotate");

    let output = result.text;
    if (isDiff) output = snapshotDiff(this.lastSnapshot, result.text);
    this.lastSnapshot = result.text;

    if (isAnnotate) {
      const outputIdx = flags.indexOf("-o");
      const longOutputIdx = flags.indexOf("--output");
      const pathIdx = outputIdx >= 0 ? outputIdx + 1 : longOutputIdx >= 0 ? longOutputIdx + 1 : -1;
      if (pathIdx >= 0 && pathIdx < flags.length) {
        await this.screenshot(flags[pathIdx]);
        output += `\n\nAnnotated screenshot saved (note: mobile screenshots do not have overlay boxes)`;
      }
    }

    return output;
  }

  async text(): Promise<string> {
    const sid = this.ensureSession();
    const xml = (await appiumGet(sid, "/source")) as string;
    const labels: string[] = [];
    const labelRegex = /\blabel="([^"]*)"/g;
    const valueRegex = /\bvalue="([^"]*)"/g;

    let match: RegExpExecArray | null;
    while ((match = labelRegex.exec(xml)) !== null) {
      if (match[1].trim()) labels.push(match[1].trim());
    }
    while ((match = valueRegex.exec(xml)) !== null) {
      if (match[1].trim()) labels.push(match[1].trim());
    }

    const seen = new Set<string>();
    const unique = labels.filter((l) => { if (seen.has(l)) return false; seen.add(l); return true; });
    return unique.join("\n") || "(no visible text)";
  }

  async scroll(direction: string): Promise<string> {
    const sid = this.ensureSession();
    let startX = 200, startY = 400, endX = 200, endY = 400;

    switch (direction.toLowerCase()) {
      case "down": startY = 500; endY = 200; break;
      case "up": startY = 200; endY = 500; break;
      case "left": startX = 300; endX = 50; break;
      case "right": startX = 50; endX = 300; break;
      default: startY = 500; endY = 200;
    }

    await appiumPost(sid, "/actions", swipeAction(startX, startY, endX, endY));
    return `Scrolled ${direction || "down"}`;
  }

  async back(): Promise<string> {
    const sid = this.ensureSession();
    await appiumPost(sid, "/back");
    return "Navigated back";
  }

  async viewport(size: string): Promise<string> {
    const sid = this.ensureSession();
    if (size.toLowerCase() === "landscape" || size.toLowerCase() === "portrait") {
      const orientation = size.toLowerCase() === "landscape" ? "LANDSCAPE" : "PORTRAIT";
      await appiumPost(sid, "/orientation", { orientation });
      return `Set orientation to ${orientation}`;
    }
    return `Viewport size change not supported mid-session. Use: "landscape" or "portrait"`;
  }

  async links(): Promise<string> {
    if (this.refs.size === 0) return "(no tappable elements — run snapshot first)";
    const lines: string[] = [];
    for (const [key, entry] of this.refs) {
      const type = entry.elementType.replace("XCUIElementType", "");
      const label = entry.label ? ` "${entry.label}"` : "";
      lines.push(`@${key} ${type}${label}`);
    }
    return lines.join("\n") || "(no tappable elements)";
  }

  async forms(): Promise<string> {
    const inputTypes = new Set(["XCUIElementTypeTextField", "XCUIElementTypeSecureTextField", "XCUIElementTypeSearchField", "XCUIElementTypeTextView"]);
    const lines: string[] = [];
    for (const [key, entry] of this.refs) {
      if (inputTypes.has(entry.elementType)) {
        const type = entry.elementType.replace("XCUIElementType", "");
        const label = entry.label ? ` "${entry.label}"` : "";
        lines.push(`@${key} ${type}${label}`);
      }
    }
    return lines.join("\n") || "(no input fields found)";
  }

  async dialogAccept(): Promise<string> {
    const sid = this.ensureSession();
    try { await appiumPost(sid, "/alert/accept"); return "Alert accepted"; }
    catch { return "No alert to accept"; }
  }

  async dialogDismiss(): Promise<string> {
    const sid = this.ensureSession();
    try { await appiumPost(sid, "/alert/dismiss"); return "Alert dismissed"; }
    catch { return "No alert to dismiss"; }
  }
}
