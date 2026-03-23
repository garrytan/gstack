import { describe, test, expect } from "bun:test";
import { parseXmlToRefs, resolveRef, snapshotDiff } from "../src/ref-system";

// Sample iOS accessibility tree XML (simplified from real Appium output)
const SAMPLE_XML = `<?xml version="1.0" encoding="UTF-8"?>
<AppiumAUT>
  <XCUIElementTypeApplication type="XCUIElementTypeApplication" name="TestApp" label="TestApp" visible="true" x="0" y="0" width="390" height="844">
    <XCUIElementTypeWindow type="XCUIElementTypeWindow" visible="true" x="0" y="0" width="390" height="844">
      <XCUIElementTypeOther type="XCUIElementTypeOther" visible="true" x="0" y="0" width="390" height="844">
        <XCUIElementTypeStaticText type="XCUIElementTypeStaticText" label="Welcome" visible="true" accessible="true" x="20" y="100" width="350" height="30" />
        <XCUIElementTypeButton type="XCUIElementTypeButton" label="Sign In" visible="true" x="20" y="200" width="350" height="44" index="0" />
        <XCUIElementTypeTextField type="XCUIElementTypeTextField" label="Email" visible="true" x="20" y="300" width="350" height="44" index="0" />
        <XCUIElementTypeSecureTextField type="XCUIElementTypeSecureTextField" label="Password" visible="true" x="20" y="360" width="350" height="44" index="0" />
        <XCUIElementTypeSwitch type="XCUIElementTypeSwitch" label="Remember me" visible="true" x="20" y="420" width="51" height="31" index="0" />
        <XCUIElementTypeButton type="XCUIElementTypeButton" label="Forgot Password?" visible="true" x="20" y="480" width="350" height="30" index="1" />
      </XCUIElementTypeOther>
    </XCUIElementTypeWindow>
  </XCUIElementTypeApplication>
</AppiumAUT>`;

const XML_WITH_TESTID = `<?xml version="1.0" encoding="UTF-8"?>
<AppiumAUT>
  <XCUIElementTypeApplication type="XCUIElementTypeApplication" visible="true" x="0" y="0" width="390" height="844">
    <XCUIElementTypeButton type="XCUIElementTypeButton" testID="submit-btn" label="Submit" visible="true" x="20" y="200" width="350" height="44" index="0" />
    <XCUIElementTypeTextField type="XCUIElementTypeTextField" testID="email-input" label="Email address" visible="true" x="20" y="300" width="350" height="44" index="0" />
  </XCUIElementTypeApplication>
</AppiumAUT>`;

describe("parseXmlToRefs", () => {
  test("parses interactive elements from iOS XML", () => {
    const result = parseXmlToRefs(SAMPLE_XML);

    // Should find: StaticText (accessible), 2 Buttons, TextField, SecureTextField, Switch = 6
    expect(result.refs.size).toBeGreaterThanOrEqual(5);

    // Check that buttons are found
    const entries = [...result.refs.entries()];
    const signInBtn = entries.find(([, e]) => e.label === "Sign In");
    expect(signInBtn).toBeTruthy();
    expect(signInBtn![1].elementType).toBe("XCUIElementTypeButton");

    const emailField = entries.find(([, e]) => e.label === "Email");
    expect(emailField).toBeTruthy();
    expect(emailField![1].elementType).toBe("XCUIElementTypeTextField");
  });

  test("assigns refs in order @e1, @e2, @e3", () => {
    const result = parseXmlToRefs(SAMPLE_XML);
    const keys = [...result.refs.keys()];

    expect(keys[0]).toBe("e1");
    expect(keys[1]).toBe("e2");
    // Refs should be sequential
    for (let i = 0; i < keys.length; i++) {
      expect(keys[i]).toBe(`e${i + 1}`);
    }
  });

  test("stores bounds for coordinate fallback", () => {
    const result = parseXmlToRefs(SAMPLE_XML);
    const entries = [...result.refs.values()];
    const signIn = entries.find((e) => e.label === "Sign In");

    expect(signIn?.bounds).toEqual({
      x: 20,
      y: 200,
      width: 350,
      height: 44,
    });
  });

  test("returns formatted text output", () => {
    const result = parseXmlToRefs(SAMPLE_XML);

    expect(result.text).toContain("interactive element");
    expect(result.text).toContain("@e");
    expect(result.text).toContain("Sign In");
    expect(result.text).toContain("Button");
  });

  test("prioritizes testID for resolution strategy", () => {
    const result = parseXmlToRefs(XML_WITH_TESTID);
    const entries = [...result.refs.entries()];

    const submitBtn = entries.find(([, e]) => e.testID === "submit-btn");
    expect(submitBtn).toBeTruthy();
    expect(submitBtn![1].resolveStrategy).toBe("testID");
  });

  test("uses accessibilityLabel when no testID", () => {
    const result = parseXmlToRefs(SAMPLE_XML);
    const entries = [...result.refs.entries()];

    const signInBtn = entries.find(([, e]) => e.label === "Sign In");
    expect(signInBtn).toBeTruthy();
    expect(signInBtn![1].resolveStrategy).toBe("accessibilityLabel");
  });

  test("filters invisible elements", () => {
    const xmlWithHidden = `<?xml version="1.0" encoding="UTF-8"?>
<AppiumAUT>
  <XCUIElementTypeApplication type="XCUIElementTypeApplication" visible="true" x="0" y="0" width="390" height="844">
    <XCUIElementTypeButton type="XCUIElementTypeButton" label="Visible" visible="true" x="0" y="0" width="100" height="44" index="0" />
    <XCUIElementTypeButton type="XCUIElementTypeButton" label="Hidden" visible="false" x="0" y="0" width="100" height="44" index="1" />
  </XCUIElementTypeApplication>
</AppiumAUT>`;

    const result = parseXmlToRefs(xmlWithHidden);
    const labels = [...result.refs.values()].map((e) => e.label);

    expect(labels).toContain("Visible");
    expect(labels).not.toContain("Hidden");
  });

  test("skips wrapper elements (Window, Other, ScrollView)", () => {
    const result = parseXmlToRefs(SAMPLE_XML);
    const types = [...result.refs.values()].map((e) => e.elementType);

    expect(types).not.toContain("XCUIElementTypeApplication");
    expect(types).not.toContain("XCUIElementTypeWindow");
    expect(types).not.toContain("XCUIElementTypeOther");
  });
});

describe("resolveRef", () => {
  test("resolves ref by testID", async () => {
    const result = parseXmlToRefs(XML_WITH_TESTID);
    const mockElement = { click: () => {} };

    const findElement = async (strategy: string, selector: string) => {
      if (strategy === "accessibility id" && selector === "submit-btn") {
        return mockElement;
      }
      return null;
    };

    const resolved = await resolveRef("@e1", result.refs, findElement);
    expect(resolved).toBeTruthy();
    expect(resolved!.element).toBe(mockElement);
    expect(resolved!.usedCoordinates).toBe(false);
  });

  test("falls back to coordinate tap when element not found", async () => {
    const result = parseXmlToRefs(SAMPLE_XML);

    // Mock that always returns null (element not found by any strategy)
    const findElement = async () => null;

    const resolved = await resolveRef("@e2", result.refs, findElement);
    expect(resolved).toBeTruthy();
    expect(resolved!.usedCoordinates).toBe(true);
  });

  test("returns null for unknown ref", async () => {
    const result = parseXmlToRefs(SAMPLE_XML);
    const findElement = async () => null;

    const resolved = await resolveRef("@e999", result.refs, findElement);
    expect(resolved).toBeNull();
  });
});

describe("snapshotDiff", () => {
  test("shows no changes message when identical", () => {
    const text = "some snapshot text";
    const diff = snapshotDiff(text, text);
    expect(diff).toContain("no changes");
  });

  test("shows additions and removals", () => {
    const prev = "@e1 Button \"Login\"";
    const curr = "@e1 Button \"Sign In\"";
    const diff = snapshotDiff(prev, curr);

    expect(diff).toContain("- @e1 Button \"Login\"");
    expect(diff).toContain("+ @e1 Button \"Sign In\"");
  });

  test("handles null previous snapshot", () => {
    const curr = "@e1 Button \"Submit\"";
    const diff = snapshotDiff(null, curr);
    expect(diff).toContain("no previous snapshot");
  });
});
