/**
 * Mobile Ref System — Parse Appium getPageSource() XML into @e1, @e2 refs
 *
 * Resolution priority: testID > accessibilityLabel > XPath > coordinate tap
 */

import { XMLParser } from "fast-xml-parser";

export interface MobileRefEntry {
  xpath: string;
  bounds: { x: number; y: number; width: number; height: number } | null;
  label: string | null;
  testID: string | null;
  elementType: string;
  // For resolveRef: which strategy to use
  resolveStrategy: "testID" | "accessibilityLabel" | "xpath";
}

export interface ParseResult {
  refs: Map<string, MobileRefEntry>;
  text: string;
}

// Interactive element types for iOS (XCUITest)
const IOS_INTERACTIVE_TYPES = new Set([
  "XCUIElementTypeButton",
  "XCUIElementTypeTextField",
  "XCUIElementTypeSecureTextField",
  "XCUIElementTypeSwitch",
  "XCUIElementTypeSlider",
  "XCUIElementTypeLink",
  "XCUIElementTypeSearchField",
  "XCUIElementTypeTextView",
  "XCUIElementTypeCell",
  "XCUIElementTypeImage", // Often tappable in RN
  "XCUIElementTypeSegmentedControl",
  "XCUIElementTypePicker",
  "XCUIElementTypePickerWheel",
  "XCUIElementTypeStepper",
  "XCUIElementTypePageIndicator",
  "XCUIElementTypeTab",
  "XCUIElementTypeTabBar",
]);

// Element types that are always non-interactive wrappers
const IOS_WRAPPER_TYPES = new Set([
  "XCUIElementTypeApplication",
  "XCUIElementTypeWindow",
  "XCUIElementTypeOther",
  "XCUIElementTypeGroup",
  "XCUIElementTypeScrollView",
  "XCUIElementTypeTable",
  "XCUIElementTypeCollectionView",
  "XCUIElementTypeNavigationBar",
  "XCUIElementTypeToolbar",
  "XCUIElementTypeStatusBar",
  "XCUIElementTypeKeyboard",
]);

function parseBounds(
  attrs: Record<string, string>
): MobileRefEntry["bounds"] {
  const x = parseInt(attrs.x, 10);
  const y = parseInt(attrs.y, 10);
  const width = parseInt(attrs.width, 10);
  const height = parseInt(attrs.height, 10);
  if ([x, y, width, height].some((v) => isNaN(v))) return null;
  return { x, y, width, height };
}

function isInteractive(type: string, attrs: Record<string, string>): boolean {
  if (IOS_INTERACTIVE_TYPES.has(type)) return true;

  if (type === "XCUIElementTypeStaticText") {
    const accessible = attrs.accessible;
    if (accessible === "true" && attrs.label) return true;
  }

  return false;
}

interface WalkContext {
  refs: Map<string, MobileRefEntry>;
  lines: string[];
  counter: number;
  xpathParts: string[];
  depth: number;
  maxDepth: number;
}

/**
 * With preserveOrder:true, fast-xml-parser returns:
 * [ { "TagName": [ ...children... ], ":@": { attr1: "v1", ... } }, ... ]
 *
 * Each array element is a node with one tag key + optional ":@" for attributes.
 */
function getTagAndChildren(node: Record<string, unknown>): { tag: string; children: unknown[]; attrs: Record<string, string> } | null {
  const attrs = (node[":@"] || {}) as Record<string, string>;
  for (const key of Object.keys(node)) {
    if (key === ":@" || key === "#text" || key === "?xml") continue;
    const children = node[key];
    return {
      tag: key,
      children: Array.isArray(children) ? children : [],
      attrs,
    };
  }
  return null;
}

function walkNode(node: Record<string, unknown>, ctx: WalkContext): void {
  if (ctx.depth > ctx.maxDepth) return;

  const parsed = getTagAndChildren(node);
  if (!parsed) return;

  const { tag: type, children, attrs } = parsed;

  // Only process XCUIElementType nodes (or AppiumAUT root)
  if (type === "AppiumAUT") {
    for (const child of children) {
      if (typeof child === "object" && child !== null) {
        walkNode(child as Record<string, unknown>, ctx);
      }
    }
    return;
  }

  if (!type.startsWith("XCUIElementType")) return;

  const label = attrs.label || null;
  const visible = attrs.visible !== "false";

  if (!visible) return;

  ctx.xpathParts.push(`${type}[${attrs.index || "0"}]`);
  const xpath = "//" + ctx.xpathParts.join("/");
  const indent = "  ".repeat(ctx.depth);

  if (isInteractive(type, attrs)) {
    ctx.counter++;
    const refKey = `e${ctx.counter}`;
    const friendlyType = type.replace("XCUIElementType", "");

    let resolveStrategy: MobileRefEntry["resolveStrategy"] = "xpath";
    if (attrs.testID) {
      resolveStrategy = "testID";
    } else if (label) {
      resolveStrategy = "accessibilityLabel";
    }

    ctx.refs.set(refKey, {
      xpath,
      bounds: parseBounds(attrs),
      label,
      testID: attrs.testID || null,
      elementType: type,
      resolveStrategy,
    });

    const displayLabel = label ? ` "${label}"` : "";
    ctx.lines.push(`${indent}@${refKey} ${friendlyType}${displayLabel}`);
  } else if (!IOS_WRAPPER_TYPES.has(type)) {
    if (label) {
      const friendlyType = type.replace("XCUIElementType", "");
      ctx.lines.push(`${indent}${friendlyType}: "${label}"`);
    }
  }

  // Walk children
  ctx.depth++;
  for (const child of children) {
    if (typeof child === "object" && child !== null) {
      walkNode(child as Record<string, unknown>, ctx);
    }
  }
  ctx.depth--;

  ctx.xpathParts.pop();
}

/**
 * Parse Appium getPageSource() XML into refs and formatted text
 */
export function parseXmlToRefs(xml: string): ParseResult {
  if (!xml || xml.trim().length === 0) {
    return { refs: new Map(), text: "(empty screen)" };
  }

  const parser = new XMLParser({
    ignoreAttributes: false,
    attributeNamePrefix: "",
    preserveOrder: true,
    allowBooleanAttributes: true,
  });

  let parsed: unknown[];
  try {
    parsed = parser.parse(xml);
  } catch (err) {
    return {
      refs: new Map(),
      text: `(error parsing accessibility tree: ${err instanceof Error ? err.message : String(err)})`,
    };
  }

  const ctx: WalkContext = {
    refs: new Map(),
    lines: [],
    counter: 0,
    xpathParts: [],
    depth: 0,
    maxDepth: 150,
  };

  // Walk all root nodes
  if (Array.isArray(parsed)) {
    for (const node of parsed) {
      if (typeof node === "object" && node !== null) {
        walkNode(node as Record<string, unknown>, ctx);
      }
    }
  }

  const summary = `${ctx.refs.size} interactive element${ctx.refs.size !== 1 ? "s" : ""} found`;
  const text = ctx.lines.length > 0
    ? `${summary}\n\n${ctx.lines.join("\n")}`
    : `${summary}\n\n(no interactive elements on this screen)`;

  return { refs: ctx.refs, text };
}

/**
 * Resolve a ref like "@e3" to a WebDriverIO element using the stored resolution strategy.
 *
 * This function is called by MobileDriver and uses the driver to find elements.
 * It implements the 3-step staleness recovery:
 *   1. Try primary strategy (testID/label/xpath)
 *   2. If not found, try by label
 *   3. If still not found, return null (caller should auto-refresh snapshot)
 */
export async function resolveRef(
  ref: string,
  refs: Map<string, MobileRefEntry>,
  findElement: (strategy: string, selector: string) => Promise<unknown | null>,
): Promise<{ element: unknown; usedCoordinates: boolean } | null> {
  const key = ref.startsWith("@") ? ref.slice(1) : ref;
  const entry = refs.get(key);

  if (!entry) {
    return null;
  }

  // Step 1: Try primary resolution strategy
  let element: unknown | null = null;

  if (entry.resolveStrategy === "testID" && entry.testID) {
    element = await findElement("accessibility id", entry.testID);
  } else if (entry.resolveStrategy === "accessibilityLabel" && entry.label) {
    element = await findElement("accessibility id", entry.label);
  }

  if (!element) {
    // Step 2: Try XPath
    element = await findElement("xpath", entry.xpath);
  }

  if (element) {
    return { element, usedCoordinates: false };
  }

  // Step 3: Try label as fallback if we haven't already
  if (entry.label && entry.resolveStrategy !== "accessibilityLabel") {
    element = await findElement("accessibility id", entry.label);
    if (element) {
      return { element, usedCoordinates: false };
    }
  }

  // Step 4: Coordinate fallback if we have bounds
  if (entry.bounds) {
    return {
      element: {
        _coordinateTap: true,
        x: entry.bounds.x + entry.bounds.width / 2,
        y: entry.bounds.y + entry.bounds.height / 2,
      },
      usedCoordinates: true,
    };
  }

  return null;
}

/**
 * Format a snapshot diff between two snapshot texts
 */
export function snapshotDiff(
  previous: string | null,
  current: string,
): string {
  if (!previous) {
    return current + "\n\n(no previous snapshot to diff against)";
  }

  const prevLines = previous.split("\n");
  const currLines = current.split("\n");
  const result: string[] = [];

  // Simple line-by-line diff
  const maxLen = Math.max(prevLines.length, currLines.length);
  let hasChanges = false;

  for (let i = 0; i < maxLen; i++) {
    const prev = prevLines[i] || "";
    const curr = currLines[i] || "";

    if (prev === curr) {
      result.push(`  ${curr}`);
    } else {
      hasChanges = true;
      if (prev) result.push(`- ${prev}`);
      if (curr) result.push(`+ ${curr}`);
    }
  }

  if (!hasChanges) {
    return "(no changes since last snapshot)";
  }

  return result.join("\n");
}
