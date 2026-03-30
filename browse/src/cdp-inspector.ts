/**
 * CDP Inspector — Chrome DevTools Protocol integration for deep CSS inspection
 *
 * Manages a persistent CDP session per active page for:
 *   - Full CSS rule cascade inspection (matched rules, computed styles, inline styles)
 *   - Box model measurement
 *   - Live CSS modification via CSS.setStyleTexts
 *   - Modification history with undo/reset
 *
 * Session lifecycle:
 *   Create on first inspect call → reuse across inspections → detach on
 *   navigation/tab switch/shutdown → re-create transparently on next call
 */

import type { Page } from 'playwright';

// ─── Types ──────────────────────────────────────────────────────

export interface InspectorResult {
  selector: string;
  tagName: string;
  id: string | null;
  classes: string[];
  attributes: Record<string, string>;
  boxModel: {
    content: { x: number; y: number; width: number; height: number };
    padding: { top: number; right: number; bottom: number; left: number };
    border: { top: number; right: number; bottom: number; left: number };
    margin: { top: number; right: number; bottom: number; left: number };
  };
  computedStyles: Record<string, string>;
  matchedRules: Array<{
    selector: string;
    properties: Array<{ name: string; value: string; important: boolean; overridden: boolean }>;
    source: string;
    sourceLine: number;
    sourceColumn: number;
    specificity: { a: number; b: number; c: number };
    media?: string;
    userAgent: boolean;
    styleSheetId?: string;
    range?: object;
  }>;
  inlineStyles: Record<string, string>;
  pseudoElements: Array<{
    pseudo: string;
    rules: Array<{ selector: string; properties: string }>;
  }>;
}

export interface StyleModification {
  selector: string;
  property: string;
  oldValue: string;
  newValue: string;
  source: string;
  sourceLine: number;
  timestamp: number;
  method: 'setStyleTexts' | 'inline';
}

// ─── Constants ──────────────────────────────────────────────────

/** ~55 key CSS properties for computed style output */
const KEY_CSS_PROPERTIES = [
  'display', 'position', 'top', 'right', 'bottom', 'left',
  'float', 'clear', 'z-index', 'overflow', 'overflow-x', 'overflow-y',
  'width', 'height', 'min-width', 'max-width', 'min-height', 'max-height',
  'margin-top', 'margin-right', 'margin-bottom', 'margin-left',
  'padding-top', 'padding-right', 'padding-bottom', 'padding-left',
  'border-top-width', 'border-right-width', 'border-bottom-width', 'border-left-width',
  'border-style', 'border-color',
  'font-family', 'font-size', 'font-weight', 'line-height',
  'color', 'background-color', 'background-image', 'opacity',
  'box-shadow', 'border-radius', 'transform', 'transition',
  'flex-direction', 'flex-wrap', 'justify-content', 'align-items', 'gap',
  'grid-template-columns', 'grid-template-rows',
  'text-align', 'text-decoration', 'visibility', 'cursor', 'pointer-events',
];

const KEY_CSS_SET = new Set(KEY_CSS_PROPERTIES);

// ─── Session Management ─────────────────────────────────────────

/** Map of Page → CDP session. Sessions are reused per page. */
const cdpSessions = new WeakMap<Page, any>();
/** Track which pages have initialized DOM+CSS domains */
const initializedPages = new WeakSet<Page>();

/**
 * Get or create a CDP session for the given page.
 * Enables DOM + CSS domains on first use.
 */
async function getOrCreateSession(page: Page): Promise<any> {
  let session = cdpSessions.get(page);
  if (session) {
    // Verify session is still alive
    try {
      await session.send('DOM.getDocument', { depth: 0 });
      return session;
    } catch {
      // Session is stale — recreate
      cdpSessions.delete(page);
      initializedPages.delete(page);
    }
  }

  session = await page.context().newCDPSession(page);
  cdpSessions.set(page, session);

  // Enable DOM and CSS domains
  await session.send('DOM.enable');
  await session.send('CSS.enable');
  initializedPages.add(page);

  // Auto-detach on navigation
  page.once('framenavigated', () => {
    try {
      session.detach().catch(() => {});
    } catch {}
    cdpSessions.delete(page);
    initializedPages.delete(page);
  });

  return session;
}

// ─── Modification History ───────────────────────────────────────

const modificationHistory: StyleModification[] = [];

// ─── Specificity Calculation ────────────────────────────────────

/**
 * Parse a CSS selector and compute its specificity as {a, b, c}.
 * a = ID selectors, b = class/attr/pseudo-class, c = type/pseudo-element
 */
function computeSpecificity(selector: string): { a: number; b: number; c: number } {
  let a = 0, b = 0, c = 0;

  // Remove :not() wrapper but count its contents
  let cleaned = selector;

  // Count IDs: #foo
  const ids = cleaned.match(/#[a-zA-Z_-][\w-]*/g);
  if (ids) a += ids.length;

  // Count classes: .foo, attribute selectors: [attr], pseudo-classes: :hover (not ::)
  const classes = cleaned.match(/\.[a-zA-Z_-][\w-]*/g);
  if (classes) b += classes.length;
  const attrs = cleaned.match(/\[[^\]]+\]/g);
  if (attrs) b += attrs.length;
  const pseudoClasses = cleaned.match(/(?<!:):[a-zA-Z][\w-]*/g);
  if (pseudoClasses) b += pseudoClasses.length;

  // Count type selectors: div, span (not * universal)
  const types = cleaned.match(/(?:^|[\s+~>])([a-zA-Z][\w-]*)/g);
  if (types) c += types.length;
  // Count pseudo-elements: ::before, ::after
  const pseudoElements = cleaned.match(/::[a-zA-Z][\w-]*/g);
  if (pseudoElements) c += pseudoElements.length;

  return { a, b, c };
}

/**
 * Compare specificities: returns negative if s1 < s2, positive if s1 > s2, 0 if equal.
 */
function compareSpecificity(
  s1: { a: number; b: number; c: number },
  s2: { a: number; b: number; c: number }
): number {
  if (s1.a !== s2.a) return s1.a - s2.a;
  if (s1.b !== s2.b) return s1.b - s2.b;
  return s1.c - s2.c;
}

// ─── Core Functions ─────────────────────────────────────────────

/**
 * Inspect an element via CDP, returning full CSS cascade data.
 */
export async function inspectElement(
  page: Page,
  selector: string,
  options?: { includeUA?: boolean }
): Promise<InspectorResult> {
  const session = await getOrCreateSession(page);

  // Get document root
  const { root } = await session.send('DOM.getDocument', { depth: 0 });

  // Query for the element
  let nodeId: number;
  try {
    const result = await session.send('DOM.querySelector', {
      nodeId: root.nodeId,
      selector,
    });
    nodeId = result.nodeId;
    if (!nodeId) throw new Error(`Element not found: ${selector}`);
  } catch (err: any) {
    throw new Error(`Element not found: ${selector} — ${err.message}`);
  }

  // Get element attributes
  const { node } = await session.send('DOM.describeNode', { nodeId, depth: 0 });
  const tagName = (node.localName || node.nodeName || '').toLowerCase();
  const attrPairs = node.attributes || [];
  const attributes: Record<string, string> = {};
  for (let i = 0; i < attrPairs.length; i += 2) {
    attributes[attrPairs[i]] = attrPairs[i + 1];
  }
  const id = attributes.id || null;
  const classes = attributes.class ? attributes.class.split(/\s+/).filter(Boolean) : [];

  // Get box model
  let boxModel = {
    content: { x: 0, y: 0, width: 0, height: 0 },
    padding: { top: 0, right: 0, bottom: 0, left: 0 },
    border: { top: 0, right: 0, bottom: 0, left: 0 },
    margin: { top: 0, right: 0, bottom: 0, left: 0 },
  };

  try {
    const boxData = await session.send('DOM.getBoxModel', { nodeId });
    const model = boxData.model;

    // Content quad: [x1,y1, x2,y2, x3,y3, x4,y4]
    const content = model.content;
    const padding = model.padding;
    const border = model.border;
    const margin = model.margin;

    const contentX = content[0];
    const contentY = content[1];
    const contentWidth = content[2] - content[0];
    const contentHeight = content[5] - content[1];

    boxModel = {
      content: { x: contentX, y: contentY, width: contentWidth, height: contentHeight },
      padding: {
        top: content[1] - padding[1],
        right: padding[2] - content[2],
        bottom: padding[5] - content[5],
        left: content[0] - padding[0],
      },
      border: {
        top: padding[1] - border[1],
        right: border[2] - padding[2],
        bottom: border[5] - padding[5],
        left: padding[0] - border[0],
      },
      margin: {
        top: border[1] - margin[1],
        right: margin[2] - border[2],
        bottom: margin[5] - border[5],
        left: border[0] - margin[0],
      },
    };
  } catch {
    // Element may not have a box model (e.g., display:none)
  }

  // Get matched styles
  const matchedData = await session.send('CSS.getMatchedStylesForNode', { nodeId });

  // Get computed styles
  const computedData = await session.send('CSS.getComputedStyleForNode', { nodeId });
  const computedStyles: Record<string, string> = {};
  for (const entry of computedData.computedStyle) {
    if (KEY_CSS_SET.has(entry.name)) {
      computedStyles[entry.name] = entry.value;
    }
  }

  // Get inline styles
  const inlineData = await session.send('CSS.getInlineStylesForNode', { nodeId });
  const inlineStyles: Record<string, string> = {};
  if (inlineData.inlineStyle?.cssProperties) {
    for (const prop of inlineData.inlineStyle.cssProperties) {
      if (prop.name && prop.value && !prop.disabled) {
        inlineStyles[prop.name] = prop.value;
      }
    }
  }

  // Process matched rules
  const matchedRules: InspectorResult['matchedRules'] = [];

  // Track all property values to mark overridden ones
  const seenProperties = new Map<string, number>(); // property → index of highest-specificity rule

  if (matchedData.matchedCSSRules) {
    for (const match of matchedData.matchedCSSRules) {
      const rule = match.rule;
      const isUA = rule.origin === 'user-agent';

      if (isUA && !options?.includeUA) continue;

      // Get the matching selector text
      let selectorText = '';
      if (rule.selectorList?.selectors) {
        // Use the specific matching selector
        const matchingIdx = match.matchingSelectors?.[0] ?? 0;
        selectorText = rule.selectorList.selectors[matchingIdx]?.text || rule.selectorList.text || '';
      }

      // Get source info
      let source = 'inline';
      let sourceLine = 0;
      let sourceColumn = 0;
      let styleSheetId: string | undefined;
      let range: object | undefined;

      if (rule.styleSheetId) {
        styleSheetId = rule.styleSheetId;
        try {
          // Try to resolve stylesheet URL
          source = rule.origin === 'regular' ? (rule.styleSheetId || 'stylesheet') : rule.origin;
        } catch {}
      }

      if (rule.style?.range) {
        range = rule.style.range;
        sourceLine = rule.style.range.startLine || 0;
        sourceColumn = rule.style.range.startColumn || 0;
      }

      // Try to get a friendly source name from stylesheet
      if (styleSheetId) {
        try {
          // Stylesheet URL might be embedded in the rule data
          // CDP provides sourceURL in some cases
          if (rule.style?.cssText) {
            // Parse source from the styleSheetId metadata
          }
        } catch {}
      }

      // Get media query if present
      let media: string | undefined;
      if (match.rule?.media) {
        const mediaList = match.rule.media;
        if (Array.isArray(mediaList) && mediaList.length > 0) {
          media = mediaList.map((m: any) => m.text).filter(Boolean).join(', ');
        }
      }

      const specificity = computeSpecificity(selectorText);

      // Process CSS properties
      const properties: Array<{ name: string; value: string; important: boolean; overridden: boolean }> = [];
      if (rule.style?.cssProperties) {
        for (const prop of rule.style.cssProperties) {
          if (!prop.name || prop.disabled) continue;
          // Skip internal/vendor properties unless they are in our key set
          if (prop.name.startsWith('-') && !KEY_CSS_SET.has(prop.name)) continue;

          properties.push({
            name: prop.name,
            value: prop.value || '',
            important: prop.important || (prop.value?.includes('!important') ?? false),
            overridden: false, // will be set later
          });
        }
      }

      matchedRules.push({
        selector: selectorText,
        properties,
        source,
        sourceLine,
        sourceColumn,
        specificity,
        media,
        userAgent: isUA,
        styleSheetId,
        range,
      });
    }
  }

  // Sort by specificity (highest first — these win)
  matchedRules.sort((a, b) => -compareSpecificity(a.specificity, b.specificity));

  // Mark overridden properties: the first rule in the sorted list (highest specificity) wins
  for (let i = 0; i < matchedRules.length; i++) {
    for (const prop of matchedRules[i].properties) {
      const key = prop.name;
      if (!seenProperties.has(key)) {
        seenProperties.set(key, i);
      } else {
        // This property was already declared by a higher-specificity rule
        // Unless this one is !important and the earlier one isn't
        const earlierIdx = seenProperties.get(key)!;
        const earlierRule = matchedRules[earlierIdx];
        const earlierProp = earlierRule.properties.find(p => p.name === key);
        if (prop.important && earlierProp && !earlierProp.important) {
          // This !important overrides the earlier non-important
          if (earlierProp) earlierProp.overridden = true;
          seenProperties.set(key, i);
        } else {
          prop.overridden = true;
        }
      }
    }
  }

  // Process pseudo-elements
  const pseudoElements: InspectorResult['pseudoElements'] = [];
  if (matchedData.pseudoElements) {
    for (const pseudo of matchedData.pseudoElements) {
      const pseudoType = pseudo.pseudoType || 'unknown';
      const rules: Array<{ selector: string; properties: string }> = [];
      if (pseudo.matches) {
        for (const match of pseudo.matches) {
          const rule = match.rule;
          const sel = rule.selectorList?.text || '';
          const props = (rule.style?.cssProperties || [])
            .filter((p: any) => p.name && !p.disabled)
            .map((p: any) => `${p.name}: ${p.value}`)
            .join('; ');
          if (props) {
            rules.push({ selector: sel, properties: props });
          }
        }
      }
      if (rules.length > 0) {
        pseudoElements.push({ pseudo: `::${pseudoType}`, rules });
      }
    }
  }

  // Resolve stylesheet URLs for better source info
  for (const rule of matchedRules) {
    if (rule.styleSheetId && rule.source !== 'inline') {
      try {
        const sheetMeta = await session.send('CSS.getStyleSheetText', { styleSheetId: rule.styleSheetId }).catch(() => null);
        // Try to get the stylesheet header for URL info
        // The styleSheetId itself is opaque, but we can try to get source URL
      } catch {}
    }
  }

  return {
    selector,
    tagName,
    id,
    classes,
    attributes,
    boxModel,
    computedStyles,
    matchedRules,
    inlineStyles,
    pseudoElements,
  };
}

/**
 * Modify a CSS property on an element.
 * Uses CSS.setStyleTexts in headed mode, falls back to inline style in headless.
 */
export async function modifyStyle(
  page: Page,
  selector: string,
  property: string,
  value: string
): Promise<StyleModification> {
  // Validate CSS property name
  if (!/^[a-zA-Z-]+$/.test(property)) {
    throw new Error(`Invalid CSS property name: ${property}. Only letters and hyphens allowed.`);
  }

  let oldValue = '';
  let source = 'inline';
  let sourceLine = 0;
  let method: 'setStyleTexts' | 'inline' = 'inline';

  try {
    // Try CDP approach first
    const session = await getOrCreateSession(page);
    const result = await inspectElement(page, selector);
    oldValue = result.computedStyles[property] || '';

    // Find the most-specific matching rule that has this property
    let targetRule: InspectorResult['matchedRules'][0] | null = null;
    for (const rule of result.matchedRules) {
      if (rule.userAgent) continue;
      const hasProp = rule.properties.some(p => p.name === property);
      if (hasProp && rule.styleSheetId && rule.range) {
        targetRule = rule;
        break;
      }
    }

    if (targetRule?.styleSheetId && targetRule.range) {
      // Modify via CSS.setStyleTexts
      const range = targetRule.range as any;

      // Get current style text
      const styleText = await session.send('CSS.getStyleSheetText', {
        styleSheetId: targetRule.styleSheetId,
      });

      // Build new style text by replacing the property value
      const currentProps = targetRule.properties;
      const newPropsText = currentProps
        .map(p => {
          if (p.name === property) {
            return `${p.name}: ${value}`;
          }
          return `${p.name}: ${p.value}`;
        })
        .join('; ');

      try {
        await session.send('CSS.setStyleTexts', {
          edits: [{
            styleSheetId: targetRule.styleSheetId,
            range,
            text: newPropsText,
          }],
        });
        method = 'setStyleTexts';
        source = `${targetRule.source}:${targetRule.sourceLine}`;
        sourceLine = targetRule.sourceLine;
      } catch {
        // Fall back to inline
      }
    }

    if (method === 'inline') {
      // Fallback: modify via inline style
      await page.evaluate(
        ([sel, prop, val]) => {
          const el = document.querySelector(sel);
          if (!el) throw new Error(`Element not found: ${sel}`);
          (el as HTMLElement).style.setProperty(prop, val);
        },
        [selector, property, value]
      );
    }
  } catch (err: any) {
    // Full fallback: use page.evaluate for headless
    await page.evaluate(
      ([sel, prop, val]) => {
        const el = document.querySelector(sel);
        if (!el) throw new Error(`Element not found: ${sel}`);
        (el as HTMLElement).style.setProperty(prop, val);
      },
      [selector, property, value]
    );
  }

  const modification: StyleModification = {
    selector,
    property,
    oldValue,
    newValue: value,
    source,
    sourceLine,
    timestamp: Date.now(),
    method,
  };

  modificationHistory.push(modification);
  return modification;
}

/**
 * Undo a modification by index (or last if no index given).
 */
export async function undoModification(page: Page, index?: number): Promise<void> {
  const idx = index ?? modificationHistory.length - 1;
  if (idx < 0 || idx >= modificationHistory.length) {
    throw new Error(`No modification at index ${idx}. History has ${modificationHistory.length} entries.`);
  }

  const mod = modificationHistory[idx];

  if (mod.method === 'setStyleTexts') {
    // Try to restore via CDP
    try {
      await modifyStyle(page, mod.selector, mod.property, mod.oldValue);
      // Remove the undo modification from history (it's a restore, not a new mod)
      modificationHistory.pop();
    } catch {
      // Fall back to inline restore
      await page.evaluate(
        ([sel, prop, val]) => {
          const el = document.querySelector(sel);
          if (!el) return;
          if (val) {
            (el as HTMLElement).style.setProperty(prop, val);
          } else {
            (el as HTMLElement).style.removeProperty(prop);
          }
        },
        [mod.selector, mod.property, mod.oldValue]
      );
    }
  } else {
    // Inline modification — restore or remove
    await page.evaluate(
      ([sel, prop, val]) => {
        const el = document.querySelector(sel);
        if (!el) return;
        if (val) {
          (el as HTMLElement).style.setProperty(prop, val);
        } else {
          (el as HTMLElement).style.removeProperty(prop);
        }
      },
      [mod.selector, mod.property, mod.oldValue]
    );
  }

  modificationHistory.splice(idx, 1);
}

/**
 * Get the full modification history.
 */
export function getModificationHistory(): StyleModification[] {
  return [...modificationHistory];
}

/**
 * Reset all modifications, restoring original values.
 */
export async function resetModifications(page: Page): Promise<void> {
  // Restore in reverse order
  for (let i = modificationHistory.length - 1; i >= 0; i--) {
    const mod = modificationHistory[i];
    try {
      await page.evaluate(
        ([sel, prop, val]) => {
          const el = document.querySelector(sel);
          if (!el) return;
          if (val) {
            (el as HTMLElement).style.setProperty(prop, val);
          } else {
            (el as HTMLElement).style.removeProperty(prop);
          }
        },
        [mod.selector, mod.property, mod.oldValue]
      );
    } catch {
      // Best effort
    }
  }
  modificationHistory.length = 0;
}

/**
 * Format an InspectorResult for CLI text output.
 */
export function formatInspectorResult(
  result: InspectorResult,
  options?: { includeUA?: boolean }
): string {
  const lines: string[] = [];

  // Element header
  const classStr = result.classes.length > 0 ? ` class="${result.classes.join(' ')}"` : '';
  const idStr = result.id ? ` id="${result.id}"` : '';
  lines.push(`Element: <${result.tagName}${idStr}${classStr}>`);
  lines.push(`Selector: ${result.selector}`);

  const w = Math.round(result.boxModel.content.width + result.boxModel.padding.left + result.boxModel.padding.right);
  const h = Math.round(result.boxModel.content.height + result.boxModel.padding.top + result.boxModel.padding.bottom);
  lines.push(`Dimensions: ${w} x ${h}`);
  lines.push('');

  // Box model
  lines.push('Box Model:');
  const bm = result.boxModel;
  lines.push(`  margin:  ${Math.round(bm.margin.top)}px  ${Math.round(bm.margin.right)}px  ${Math.round(bm.margin.bottom)}px  ${Math.round(bm.margin.left)}px`);
  lines.push(`  padding: ${Math.round(bm.padding.top)}px  ${Math.round(bm.padding.right)}px  ${Math.round(bm.padding.bottom)}px  ${Math.round(bm.padding.left)}px`);
  lines.push(`  border:  ${Math.round(bm.border.top)}px  ${Math.round(bm.border.right)}px  ${Math.round(bm.border.bottom)}px  ${Math.round(bm.border.left)}px`);
  lines.push(`  content: ${Math.round(bm.content.width)} x ${Math.round(bm.content.height)}`);
  lines.push('');

  // Matched rules
  const displayRules = options?.includeUA
    ? result.matchedRules
    : result.matchedRules.filter(r => !r.userAgent);

  lines.push(`Matched Rules (${displayRules.length}):`);
  if (displayRules.length === 0) {
    lines.push('  (none)');
  } else {
    for (const rule of displayRules) {
      const propsStr = rule.properties
        .filter(p => !p.overridden)
        .map(p => `${p.name}: ${p.value}${p.important ? ' !important' : ''}`)
        .join('; ');
      if (!propsStr) continue;
      const spec = `[${rule.specificity.a},${rule.specificity.b},${rule.specificity.c}]`;
      lines.push(`  ${rule.selector} { ${propsStr} }`);
      lines.push(`    -> ${rule.source}:${rule.sourceLine} ${spec}${rule.media ? ` @media ${rule.media}` : ''}`);
    }
  }
  lines.push('');

  // Inline styles
  lines.push('Inline Styles:');
  const inlineEntries = Object.entries(result.inlineStyles);
  if (inlineEntries.length === 0) {
    lines.push('  (none)');
  } else {
    const inlineStr = inlineEntries.map(([k, v]) => `${k}: ${v}`).join('; ');
    lines.push(`  ${inlineStr}`);
  }
  lines.push('');

  // Computed styles (key properties, compact format)
  lines.push('Computed (key):');
  const cs = result.computedStyles;
  const computedPairs: string[] = [];
  for (const prop of KEY_CSS_PROPERTIES) {
    if (cs[prop] !== undefined) {
      computedPairs.push(`${prop}: ${cs[prop]}`);
    }
  }
  // Group into lines of ~3 properties each
  for (let i = 0; i < computedPairs.length; i += 3) {
    const chunk = computedPairs.slice(i, i + 3);
    lines.push(`  ${chunk.join(' | ')}`);
  }

  // Pseudo-elements
  if (result.pseudoElements.length > 0) {
    lines.push('');
    lines.push('Pseudo-elements:');
    for (const pseudo of result.pseudoElements) {
      for (const rule of pseudo.rules) {
        lines.push(`  ${pseudo.pseudo} ${rule.selector} { ${rule.properties} }`);
      }
    }
  }

  return lines.join('\n');
}

/**
 * Detach CDP session for a page (or all pages).
 */
export function detachSession(page?: Page): void {
  if (page) {
    const session = cdpSessions.get(page);
    if (session) {
      try { session.detach().catch(() => {}); } catch {}
      cdpSessions.delete(page);
      initializedPages.delete(page);
    }
  }
  // Note: WeakMap doesn't support iteration, so we can't detach all.
  // Callers with specific pages should call this per-page.
}
