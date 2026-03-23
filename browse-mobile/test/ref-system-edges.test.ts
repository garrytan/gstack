import { describe, test, expect } from "bun:test";
import { parseXmlToRefs, resolveRef } from "../src/ref-system";

describe("parseXmlToRefs — edge cases", () => {
  test("handles empty string input", () => {
    const result = parseXmlToRefs("");
    expect(result.refs.size).toBe(0);
    expect(result.text).toContain("empty screen");
  });

  test("handles null-ish input", () => {
    const result = parseXmlToRefs(null as unknown as string);
    expect(result.refs.size).toBe(0);
  });

  test("handles malformed XML gracefully", () => {
    const result = parseXmlToRefs("<broken><not closed");
    // Should not throw — returns error message
    expect(result.refs.size).toBe(0);
    expect(result.text).toContain("error parsing");
  });

  test("handles XML with no interactive elements", () => {
    const xml = `<?xml version="1.0" encoding="UTF-8"?>
<AppiumAUT>
  <XCUIElementTypeApplication type="XCUIElementTypeApplication" visible="true" x="0" y="0" width="390" height="844">
    <XCUIElementTypeWindow type="XCUIElementTypeWindow" visible="true" x="0" y="0" width="390" height="844">
      <XCUIElementTypeOther type="XCUIElementTypeOther" visible="true" x="0" y="0" width="390" height="844" />
    </XCUIElementTypeWindow>
  </XCUIElementTypeApplication>
</AppiumAUT>`;

    const result = parseXmlToRefs(xml);
    expect(result.refs.size).toBe(0);
    expect(result.text).toContain("0 interactive elements");
    expect(result.text).toContain("no interactive elements");
  });

  test("handles deeply nested XML (100+ depth) without stack overflow", () => {
    // Build a deeply nested XML tree
    let xml = '<?xml version="1.0" encoding="UTF-8"?>\n<AppiumAUT>';
    for (let i = 0; i < 120; i++) {
      xml += `<XCUIElementTypeOther type="XCUIElementTypeOther" visible="true" x="0" y="0" width="390" height="844">`;
    }
    xml += `<XCUIElementTypeButton type="XCUIElementTypeButton" label="Deep Button" visible="true" x="20" y="200" width="350" height="44" index="0" />`;
    for (let i = 0; i < 120; i++) {
      xml += `</XCUIElementTypeOther>`;
    }
    xml += "</AppiumAUT>";

    // Should not throw
    const result = parseXmlToRefs(xml);
    // The button is at depth 122 which exceeds maxDepth of 150, so it should still be found
    // (maxDepth is generous)
    expect(result.text).toBeDefined();
  });

  test("handles elements with missing bounds", () => {
    const xml = `<?xml version="1.0" encoding="UTF-8"?>
<AppiumAUT>
  <XCUIElementTypeApplication type="XCUIElementTypeApplication" visible="true">
    <XCUIElementTypeButton type="XCUIElementTypeButton" label="No Bounds" visible="true" index="0" />
  </XCUIElementTypeApplication>
</AppiumAUT>`;

    const result = parseXmlToRefs(xml);
    const btn = [...result.refs.values()].find((e) => e.label === "No Bounds");
    expect(btn).toBeTruthy();
    expect(btn!.bounds).toBeNull();
  });

  test("handles elements with empty labels", () => {
    const xml = `<?xml version="1.0" encoding="UTF-8"?>
<AppiumAUT>
  <XCUIElementTypeApplication type="XCUIElementTypeApplication" visible="true" x="0" y="0" width="390" height="844">
    <XCUIElementTypeButton type="XCUIElementTypeButton" label="" visible="true" x="20" y="200" width="100" height="44" index="0" />
    <XCUIElementTypeButton type="XCUIElementTypeButton" visible="true" x="20" y="300" width="100" height="44" index="1" />
  </XCUIElementTypeApplication>
</AppiumAUT>`;

    const result = parseXmlToRefs(xml);
    // Buttons should still be found even without labels
    expect(result.refs.size).toBeGreaterThanOrEqual(1);
  });

  test("handles many interactive elements (100+) without performance issues", () => {
    let elements = "";
    for (let i = 0; i < 150; i++) {
      elements += `<XCUIElementTypeButton type="XCUIElementTypeButton" label="Button ${i}" visible="true" x="0" y="${i * 50}" width="100" height="44" index="${i}" />`;
    }

    const xml = `<?xml version="1.0" encoding="UTF-8"?>
<AppiumAUT>
  <XCUIElementTypeApplication type="XCUIElementTypeApplication" visible="true" x="0" y="0" width="390" height="844">
    ${elements}
  </XCUIElementTypeApplication>
</AppiumAUT>`;

    const start = Date.now();
    const result = parseXmlToRefs(xml);
    const elapsed = Date.now() - start;

    expect(result.refs.size).toBe(150);
    expect(elapsed).toBeLessThan(1000); // Should parse in under 1s
  });
});

describe("resolveRef — staleness and fallback", () => {
  test("falls back to XPath when testID element not found", async () => {
    const xml = `<?xml version="1.0" encoding="UTF-8"?>
<AppiumAUT>
  <XCUIElementTypeApplication type="XCUIElementTypeApplication" visible="true" x="0" y="0" width="390" height="844">
    <XCUIElementTypeButton type="XCUIElementTypeButton" testID="my-btn" label="My Button" visible="true" x="20" y="200" width="100" height="44" index="0" />
  </XCUIElementTypeApplication>
</AppiumAUT>`;

    const result = parseXmlToRefs(xml);
    const xpathElement = { click: () => {} };

    // testID lookup fails, but XPath succeeds
    const findElement = async (strategy: string, selector: string) => {
      if (strategy === "xpath") return xpathElement;
      return null;
    };

    const resolved = await resolveRef("@e1", result.refs, findElement);
    expect(resolved).toBeTruthy();
    expect(resolved!.element).toBe(xpathElement);
    expect(resolved!.usedCoordinates).toBe(false);
  });

  test("falls back to label when XPath also fails", async () => {
    const xml = `<?xml version="1.0" encoding="UTF-8"?>
<AppiumAUT>
  <XCUIElementTypeApplication type="XCUIElementTypeApplication" visible="true" x="0" y="0" width="390" height="844">
    <XCUIElementTypeButton type="XCUIElementTypeButton" testID="btn" label="Click Me" visible="true" x="20" y="200" width="100" height="44" index="0" />
  </XCUIElementTypeApplication>
</AppiumAUT>`;

    const result = parseXmlToRefs(xml);
    const labelElement = { click: () => {} };

    let callCount = 0;
    const findElement = async (strategy: string, selector: string) => {
      callCount++;
      // testID fails (call 1), xpath fails (call 2), label succeeds (call 3)
      if (callCount === 3 && strategy === "accessibility id" && selector === "Click Me") {
        return labelElement;
      }
      return null;
    };

    const resolved = await resolveRef("@e1", result.refs, findElement);
    expect(resolved).toBeTruthy();
    expect(resolved!.usedCoordinates).toBe(false);
  });

  test("uses coordinate fallback as last resort", async () => {
    const xml = `<?xml version="1.0" encoding="UTF-8"?>
<AppiumAUT>
  <XCUIElementTypeApplication type="XCUIElementTypeApplication" visible="true" x="0" y="0" width="390" height="844">
    <XCUIElementTypeButton type="XCUIElementTypeButton" label="Tap Me" visible="true" x="100" y="200" width="80" height="40" index="0" />
  </XCUIElementTypeApplication>
</AppiumAUT>`;

    const result = parseXmlToRefs(xml);

    // All strategies fail
    const findElement = async () => null;

    const resolved = await resolveRef("@e1", result.refs, findElement);
    expect(resolved).toBeTruthy();
    expect(resolved!.usedCoordinates).toBe(true);

    // Should tap center of bounds (100+40, 200+20)
    const coords = resolved!.element as { x: number; y: number };
    expect(coords.x).toBe(140); // 100 + 80/2
    expect(coords.y).toBe(220); // 200 + 40/2
  });

  test("returns null for element with no bounds and all strategies fail", async () => {
    const xml = `<?xml version="1.0" encoding="UTF-8"?>
<AppiumAUT>
  <XCUIElementTypeApplication type="XCUIElementTypeApplication" visible="true">
    <XCUIElementTypeButton type="XCUIElementTypeButton" label="Ghost" visible="true" index="0" />
  </XCUIElementTypeApplication>
</AppiumAUT>`;

    const result = parseXmlToRefs(xml);
    const findElement = async () => null;

    const resolved = await resolveRef("@e1", result.refs, findElement);
    // No bounds = no coordinate fallback = null
    expect(resolved).toBeNull();
  });

  test("handles @ prefix correctly", async () => {
    const xml = `<?xml version="1.0" encoding="UTF-8"?>
<AppiumAUT>
  <XCUIElementTypeApplication type="XCUIElementTypeApplication" visible="true" x="0" y="0" width="390" height="844">
    <XCUIElementTypeButton type="XCUIElementTypeButton" label="Test" visible="true" x="0" y="0" width="100" height="44" index="0" />
  </XCUIElementTypeApplication>
</AppiumAUT>`;

    const result = parseXmlToRefs(xml);
    const el = { click: () => {} };
    const findElement = async () => el;

    // Both with and without @ prefix should work
    const r1 = await resolveRef("@e1", result.refs, findElement);
    const r2 = await resolveRef("e1", result.refs, findElement);

    expect(r1).toBeTruthy();
    expect(r2).toBeTruthy();
  });
});
