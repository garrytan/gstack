/**
 * MobileDriver — Appium WebDriverIO wrapper
 *
 * Equivalent to browse's BrowserManager, but for iOS Simulator via Appium.
 */

import { remote, attach, type Browser } from "webdriverio";
import { parseXmlToRefs, resolveRef, snapshotDiff, type MobileRefEntry, type ParseResult } from "./ref-system";
import { ensureBootedSimulator, terminateApp } from "./platform/ios";
import * as fs from "fs";
import * as path from "path";

export interface MobileDriverOptions {
  bundleId: string;
  appPath?: string;
  automationName?: string;
  platformVersion?: string;
  deviceName?: string;
}

export class MobileDriver {
  private driver: Browser | null = null;
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
      throw new Error(
        "No iOS Simulator available. Run: xcrun simctl list devices available"
      );
    }

    const capabilities: Record<string, unknown> = {
      platformName: "iOS",
      "appium:automationName": this.options.automationName || "XCUITest",
      "appium:deviceName": this.options.deviceName || sim.name,
      "appium:udid": sim.udid,
      "appium:bundleId": this.options.bundleId,
      "appium:autoAcceptAlerts": true,
      "appium:noReset": true,
      "appium:newCommandTimeout": 1800, // 30 min idle
      "appium:wdaLaunchTimeout": 120000, // 2 min for WebDriverAgent build
      "appium:wdaConnectionTimeout": 120000,
    };

    if (this.options.appPath) {
      capabilities["appium:app"] = this.options.appPath;
    }

    if (this.options.platformVersion) {
      capabilities["appium:platformVersion"] = this.options.platformVersion;
    }

    // First, create session directly via HTTP with a long timeout
    // (WebDriverIO's remote() has a short default that can't be overridden reliably)
    const sessionRes = await fetch("http://127.0.0.1:4723/session", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        capabilities: { alwaysMatch: capabilities, firstMatch: [{}] },
      }),
      signal: AbortSignal.timeout(180000), // 3 min for WDA compilation
    });

    if (!sessionRes.ok) {
      const errText = await sessionRes.text();
      throw new Error(`Appium session creation failed (${sessionRes.status}): ${errText}`);
    }

    const sessionData = (await sessionRes.json()) as {
      value: { sessionId: string; capabilities: Record<string, unknown> };
    };
    const sessionId = sessionData.value.sessionId;

    // Attach WebDriverIO to the existing session
    this.driver = await attach({
      hostname: "127.0.0.1",
      port: 4723,
      path: "/",
      sessionId,
      capabilities,
      logLevel: "warn",
    });

    this._isConnected = true;
  }

  async disconnect(): Promise<void> {
    if (this.driver) {
      try {
        await this.driver.deleteSession();
      } catch {
        // Session may already be dead
      }
      this.driver = null;
    }
    this._isConnected = false;
    this.refs.clear();
    this.lastSnapshot = null;
  }

  get isConnected(): boolean {
    return this._isConnected && this.driver !== null;
  }

  async isHealthy(): Promise<boolean> {
    if (!this.driver) return false;
    try {
      await this.driver.getPageSource();
      return true;
    } catch {
      return false;
    }
  }

  private ensureDriver(): Browser {
    if (!this.driver) {
      throw new Error("Not connected to Appium. Call connect() first.");
    }
    return this.driver;
  }

  // ─── Ref Map ───

  setRefMap(refs: Map<string, MobileRefEntry>): void {
    this.refs = refs;
  }

  getRefCount(): number {
    return this.refs.size;
  }

  clearRefs(): void {
    this.refs.clear();
  }

  setLastSnapshot(text: string | null): void {
    this.lastSnapshot = text;
  }

  getLastSnapshot(): string | null {
    return this.lastSnapshot;
  }

  // ─── Commands ───

  async goto(target: string): Promise<string> {
    const driver = this.ensureDriver();

    if (target.startsWith("app://")) {
      // Launch/relaunch by bundle ID
      const bundleId = target.replace("app://", "");
      try {
        await driver.execute("mobile: terminateApp", { bundleId });
      } catch {
        // App may not be running
      }
      await driver.execute("mobile: launchApp", { bundleId });
      return `Launched ${bundleId}`;
    }

    // Deep link — pass URL to the app
    try {
      await driver.url(target);
      return `Navigated to ${target}`;
    } catch (err) {
      return `Deep link failed: ${err instanceof Error ? err.message : String(err)}. Navigate manually via click commands.`;
    }
  }

  async click(refOrSelector: string): Promise<string> {
    const driver = this.ensureDriver();

    if (refOrSelector.startsWith("@")) {
      const findElement = async (strategy: string, selector: string) => {
        try {
          const el = await driver.$(
            strategy === "accessibility id"
              ? `~${selector}`
              : strategy === "xpath"
                ? selector
                : selector
          );
          if (await el.isExisting()) return el;
          return null;
        } catch {
          return null;
        }
      };

      const result = await resolveRef(refOrSelector, this.refs, findElement);

      if (!result) {
        // Auto-refresh snapshot and retry once
        const refreshed = await this.snapshot([]);
        const retryResult = await resolveRef(
          refOrSelector,
          this.refs,
          findElement
        );
        if (!retryResult) {
          throw new Error(
            `Element ${refOrSelector} no longer exists — screen may have navigated`
          );
        }
        return this.performClick(driver, retryResult);
      }

      return this.performClick(driver, result);
    }

    // Direct selector
    const el = await driver.$(refOrSelector);
    await el.click();
    return `Clicked ${refOrSelector}`;
  }

  private async performClick(
    driver: Browser,
    result: { element: unknown; usedCoordinates: boolean }
  ): Promise<string> {
    if (result.usedCoordinates) {
      const coords = result.element as {
        _coordinateTap: boolean;
        x: number;
        y: number;
      };
      await driver
        .action("pointer", { parameters: { pointerType: "touch" } })
        .move({ x: Math.round(coords.x), y: Math.round(coords.y) })
        .down()
        .up()
        .perform();
      return `Tapped at coordinates (${Math.round(coords.x)}, ${Math.round(coords.y)}) — using coordinate fallback. Consider adding accessibilityLabel.`;
    }

    const el = result.element as WebdriverIO.Element;
    await el.click();

    // Find the ref entry for a friendly message
    const refKey = [...this.refs.entries()].find(
      ([, entry]) => entry.label
    );
    const label = refKey ? ` (${refKey[1].elementType.replace("XCUIElementType", "")}: "${refKey[1].label}")` : "";
    return `Clicked${label}`;
  }

  async fill(refOrSelector: string, text: string): Promise<string> {
    const driver = this.ensureDriver();

    if (refOrSelector.startsWith("@")) {
      const findElement = async (strategy: string, selector: string) => {
        try {
          const el = await driver.$(
            strategy === "accessibility id" ? `~${selector}` : selector
          );
          if (await el.isExisting()) return el;
          return null;
        } catch {
          return null;
        }
      };

      const result = await resolveRef(refOrSelector, this.refs, findElement);
      if (!result) {
        throw new Error(
          `Cannot fill ${refOrSelector} — element not found`
        );
      }

      if (result.usedCoordinates) {
        // Tap the field to focus it, then type
        const coords = result.element as { _coordinateTap: boolean; x: number; y: number };
        await driver
          .action("pointer", { parameters: { pointerType: "touch" } })
          .move({ x: Math.round(coords.x), y: Math.round(coords.y) })
          .down()
          .up()
          .perform();
        // Wait for keyboard to appear
        await new Promise((r) => setTimeout(r, 500));
        // Type via keyboard — send each char as individual key action
        const actions = driver.action("key");
        for (const char of text) {
          actions.down(char).up(char);
        }
        await actions.perform();
        return `Filled ${refOrSelector} with "${text}" (via coordinate tap + keyboard)`;
      }

      const el = result.element as WebdriverIO.Element;
      await el.clearValue();
      await el.setValue(text);
      return `Filled ${refOrSelector} with "${text}"`;
    }

    const el = await driver.$(refOrSelector);
    await el.clearValue();
    await el.setValue(text);
    return `Filled ${refOrSelector} with "${text}"`;
  }

  async screenshot(outputPath: string): Promise<string> {
    const driver = this.ensureDriver();

    const base64 = await driver.takeScreenshot();
    const buffer = Buffer.from(base64, "base64");

    try {
      const dir = path.dirname(outputPath);
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }
      fs.writeFileSync(outputPath, buffer);
    } catch (err) {
      throw new Error(
        `Screenshot save failed: ${err instanceof Error ? err.message : String(err)}. Disk may be full.`
      );
    }

    return `Screenshot saved to ${outputPath} (${buffer.length} bytes)`;
  }

  async snapshot(
    flags: string[]
  ): Promise<string> {
    const driver = this.ensureDriver();

    const xml = await driver.getPageSource();
    const result = parseXmlToRefs(xml);

    this.refs = result.refs;

    const isDiff = flags.includes("-D") || flags.includes("--diff");
    const isAnnotate = flags.includes("-a") || flags.includes("--annotate");

    let output = result.text;

    if (isDiff) {
      output = snapshotDiff(this.lastSnapshot, result.text);
    }

    this.lastSnapshot = result.text;

    if (isAnnotate) {
      // For annotated screenshots, take a screenshot with ref labels
      // (We can't inject DOM overlays like browse does, so we just take a plain screenshot
      // and note the ref positions in the text output)
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
    const driver = this.ensureDriver();

    const xml = await driver.getPageSource();
    // Extract all label/value text from the XML
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

    // Deduplicate while preserving order
    const seen = new Set<string>();
    const unique = labels.filter((l) => {
      if (seen.has(l)) return false;
      seen.add(l);
      return true;
    });

    return unique.join("\n") || "(no visible text)";
  }

  async scroll(direction: string): Promise<string> {
    const driver = this.ensureDriver();

    // Default scroll distance
    const distance = 300;
    let startX = 200,
      startY = 400,
      endX = 200,
      endY = 400;

    switch (direction.toLowerCase()) {
      case "down":
        startY = 500;
        endY = 200;
        break;
      case "up":
        startY = 200;
        endY = 500;
        break;
      case "left":
        startX = 300;
        endX = 50;
        break;
      case "right":
        startX = 50;
        endX = 300;
        break;
      default:
        // Default to scroll down
        startY = 500;
        endY = 200;
    }

    await driver
      .action("pointer", { parameters: { pointerType: "touch" } })
      .move({ x: startX, y: startY })
      .down()
      .move({ x: endX, y: endY, duration: 300 })
      .up()
      .perform();

    return `Scrolled ${direction || "down"}`;
  }

  async back(): Promise<string> {
    const driver = this.ensureDriver();
    await driver.back();
    return "Navigated back";
  }

  async viewport(size: string): Promise<string> {
    const driver = this.ensureDriver();

    if (
      size.toLowerCase() === "landscape" ||
      size.toLowerCase() === "portrait"
    ) {
      const orientation =
        size.toLowerCase() === "landscape" ? "LANDSCAPE" : "PORTRAIT";
      await driver.setOrientation(orientation);
      return `Set orientation to ${orientation}`;
    }

    return `Viewport size change not supported mid-session on mobile. Use orientation: "landscape" or "portrait"`;
  }

  async links(): Promise<string> {
    // Return all tappable elements from the last snapshot
    if (this.refs.size === 0) {
      return "(no tappable elements — run snapshot first)";
    }

    const lines: string[] = [];
    for (const [key, entry] of this.refs) {
      const type = entry.elementType.replace("XCUIElementType", "");
      const label = entry.label ? ` "${entry.label}"` : "";
      lines.push(`@${key} ${type}${label}`);
    }

    return lines.join("\n") || "(no tappable elements)";
  }

  async forms(): Promise<string> {
    // Return all input elements from the last snapshot
    const inputTypes = new Set([
      "XCUIElementTypeTextField",
      "XCUIElementTypeSecureTextField",
      "XCUIElementTypeSearchField",
      "XCUIElementTypeTextView",
    ]);

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
    const driver = this.ensureDriver();
    try {
      await driver.acceptAlert();
      return "Alert accepted";
    } catch {
      return "No alert to accept";
    }
  }

  async dialogDismiss(): Promise<string> {
    const driver = this.ensureDriver();
    try {
      await driver.dismissAlert();
      return "Alert dismissed";
    } catch {
      return "No alert to dismiss";
    }
  }
}
