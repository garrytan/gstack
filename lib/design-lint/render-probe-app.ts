/**
 * The app profile's in-page measurements (gstack-design-lint --scope app).
 * Installed on window.__gstackLintApp by their own install step, apart from
 * the page probes in render-probe.ts, which stay as they are. Each function
 * is serialised with Function.prototype.toString and sees only its arguments,
 * the helpers object and the DOM.
 *
 * Everything walks the composed tree: light DOM, every open shadow root and
 * slotted content in the order it renders. Nothing reads a test hook
 * (data-testid or any other attribute): a list is found by shape (siblings of
 * one tag and class list, similar widths, stacked, each holding text), a
 * row's name by position (the first run on its first line), a note by
 * position (a text block starting below the name's line).
 *
 * Text positions are line boxes: a text rect widened by its half-leading
 * (Chrome floors the half above the glyphs and gives the rest below), so a gap
 * measured to a row edge is the padding and margins the CSS set.
 */

export interface AppProbeFinding { rule: string; sentence: string; locator: string; measured: number; threshold: number }

export interface AppProbeResult {
  status: 'measured' | 'incomplete';
  /** Set when incomplete: NOT_READY, STATE_MISMATCH, WITHIN_NO_MATCH or CLOSED_SHADOW. */
  code?: string;
  detail?: string;
  /** Elements the --within selector matched in the composed tree. */
  matched: number;
  /** Trees searched: the document plus every open shadow root. */
  roots: number;
  lists: number;
  findings: AppProbeFinding[];
}

export interface AppSetupReport { lostSheets: string[]; lostFonts: string[] }

export interface AppMeasureArgs { within: string; expect: string | null; explicitWait: boolean; readyMs: number }

interface Run { node: Text; el: Element; block: Element; rects: DOMRect[]; top: number; bottom: number; left: number; lineTop: number; lineBottom: number }

interface AppList { container: Element; rows: Element[]; last: Element; whole: boolean }

/** Composed-tree helpers, built once by the install step. */
export function glAppHelpers() {
  const kids = (n: Node): Node[] => {
    if ((n as Element).tagName === 'SLOT') { const a = (n as HTMLSlotElement).assignedNodes({ flatten: true }); return a.length ? a : Array.from(n.childNodes); }
    const sr = (n as Element).shadowRoot;
    return Array.from(sr ? sr.childNodes : n.childNodes);
  };
  const ekids = (n: Node): Element[] => kids(n).filter((c) => c.nodeType === 1) as Element[];
  /** The element children that render as boxes: a display: contents child (a slot, a wrapper) is replaced by its own. */
  const boxKids = (n: Node): Element[] => ekids(n).flatMap((k) => (getComputedStyle(k).display === 'contents' ? boxKids(k) : [k]));
  const cparent = (n: Node): Element | null => {
    const slot = (n as Element).assignedSlot;
    if (slot) return slot;
    const p = n.parentNode;
    if (!p) return null;
    return p.nodeType === 11 ? ((p as ShadowRoot).host || null) : (p as Element).nodeType === 1 ? (p as Element) : null;
  };
  const inside = (el: Node, root: Element): boolean => { for (let e: Node | null = el; e; e = cparent(e)) if (e === root) return true; return false; };
  /** Every element under root in the composed tree, root first. */
  const desc = (root: Element): Element[] => { const out: Element[] = []; const go = (e: Element) => { out.push(e); for (const k of ekids(e)) go(k); }; go(root); return out; };
  const roots = (): Array<Document | ShadowRoot> => {
    const out: Array<Document | ShadowRoot> = [document];
    for (let i = 0; i < out.length; i++) for (const e of out[i].querySelectorAll('*')) if (e.shadowRoot) out.push(e.shadowRoot);
    return out;
  };
  const qAll = (sel: string): Element[] => { const out: Element[] = []; for (const r of roots()) for (const e of r.querySelectorAll(sel)) out.push(e); return out; };
  const shown = (el: Element): boolean => { const cs = getComputedStyle(el); return cs.display !== 'none' && cs.visibility !== 'hidden' && parseFloat(cs.opacity) !== 0; };
  const vis = (el: Element): boolean => { if (!shown(el)) return false; const r = el.getBoundingClientRect(); return r.width >= 1 && r.height >= 1; };
  const CONTROL = 'button, a[href], select, input, textarea, [role=button], [role=menuitem], [role=menuitemradio], [role=menuitemcheckbox], [role=tab], [role=switch], [role=option]';
  const isControl = (el: Element): boolean => el.matches(CONTROL);
  const blockOf = (el: Element, stop: Element): Element => {
    let e: Element = el;
    while (e !== stop) { const d = getComputedStyle(e).display; if (d !== 'inline' && d !== 'contents') break; const p = cparent(e); if (!p) break; e = p; }
    return e;
  };
  /** Visible text runs under root in rendered order, text inside controls left out. */
  const runsOf = (root: Element): Run[] => {
    const out: Run[] = [];
    const go = (n: Node, ctl: boolean): void => {
      for (const c of kids(n)) {
        if (c.nodeType === 3) {
          if (ctl || !(c.textContent || '').trim()) continue;
          const el = cparent(c);
          if (!el) continue;
          const rg = document.createRange(); rg.selectNodeContents(c);
          const rects = Array.from(rg.getClientRects()).filter((q) => q.width > 0 && q.height > 0);
          if (!rects.length) continue;
          const lh = parseFloat(getComputedStyle(el).lineHeight);
          const above = (q: DOMRect) => (Number.isFinite(lh) ? Math.floor((lh - q.height) / 2) : 0);
          const below = (q: DOMRect) => (Number.isFinite(lh) ? lh - q.height - above(q) : 0);
          out.push({ node: c as Text, el, block: blockOf(el, root), rects, top: rects[0].top, bottom: Math.max(...rects.map((q) => q.bottom)), left: rects[0].left,
            lineTop: Math.min(...rects.map((q) => q.top - above(q))), lineBottom: Math.max(...rects.map((q) => q.bottom + below(q))) });
        } else if (c.nodeType === 1) {
          const e = c as Element;
          if (/^(SCRIPT|STYLE|TEMPLATE|NOSCRIPT)$/.test(e.tagName) || !shown(e)) continue;
          go(e, ctl || isControl(e));
        }
      }
    };
    go(root, isControl(root));
    return out;
  };
  const lineCount = (runs: Run[]): number => {
    const tops = runs.flatMap((r) => r.rects.map((q) => q.top + q.height / 2)).sort((a, b) => a - b);
    let n = 0, last = -Infinity;
    for (const t of tops) { if (t - last > 4) n++; last = t; }
    return n;
  };
  const cv = document.createElement('canvas'); cv.width = cv.height = 1;
  const cx = cv.getContext('2d', { willReadFrequently: true }) as CanvasRenderingContext2D;
  const rgb = (s: string): number[] => { cx.clearRect(0, 0, 1, 1); cx.fillStyle = 'rgba(0, 0, 0, 0)'; cx.fillStyle = s; cx.fillRect(0, 0, 1, 1); const d = cx.getImageData(0, 0, 1, 1).data; return [d[0] / 255, d[1] / 255, d[2] / 255, d[3] / 255]; };
  const surface = (el: Element): boolean => {
    const cs = getComputedStyle(el);
    if (rgb(cs.backgroundColor)[3] > 0.02 || cs.backgroundImage !== 'none' || cs.boxShadow !== 'none') return true;
    return (['Top', 'Right', 'Bottom', 'Left'] as const).some((s) => parseFloat(cs.getPropertyValue('border-' + s.toLowerCase() + '-width')) > 0 && !/none|hidden/.test(cs.getPropertyValue('border-' + s.toLowerCase() + '-style')) && rgb(cs.getPropertyValue('border-' + s.toLowerCase() + '-color'))[3] > 0.02);
  };
  /** The px of a drawn edge on one side: its border width, 0 when only a background or shadow draws it, null when nothing does. */
  const drawn = (el: Element, side: 'top' | 'bottom'): number | null => {
    const cs = getComputedStyle(el);
    const w = parseFloat(cs.getPropertyValue('border-' + side + '-width'));
    if (w > 0 && !/none|hidden/.test(cs.getPropertyValue('border-' + side + '-style')) && rgb(cs.getPropertyValue('border-' + side + '-color'))[3] > 0.02) return w;
    return rgb(cs.backgroundColor)[3] > 0.02 || cs.backgroundImage !== 'none' || cs.boxShadow !== 'none' ? 0 : null;
  };
  const bgOf = (el: Element): number[] => {
    for (let n: Element | null = el; n; n = cparent(n)) { const c = rgb(getComputedStyle(n).backgroundColor); if (c[3] >= 0.9) return c; }
    return [1, 1, 1, 1];
  };
  const lightness = (el: Element, stop: Element): number => {
    const a = rgb(getComputedStyle(el).color);
    let op = 1;
    for (let n: Element | null = el; n && n !== stop; n = cparent(n)) op *= parseFloat(getComputedStyle(n).opacity);
    const bg = bgOf(el);
    const c = [0, 1, 2].map((i) => a[i] * a[3] * op + bg[i] * (1 - a[3] * op));
    const lin = c.map((v) => (v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4));
    const l = Math.cbrt(0.4122214708 * lin[0] + 0.5363325363 * lin[1] + 0.0514459929 * lin[2]);
    const m = Math.cbrt(0.2119034982 * lin[0] + 0.6806995451 * lin[1] + 0.1073969566 * lin[2]);
    const s = Math.cbrt(0.0883024619 * lin[0] + 0.2817188376 * lin[1] + 0.6299787005 * lin[2]);
    return 0.2104542553 * l + 0.793617785 * m - 0.0040720403 * s;
  };
  const seg = (e: Element): string => {
    const cls = (e.getAttribute('class') || '').trim().split(/\s+/).filter(Boolean).slice(0, 2);
    const p = e.parentElement || (e.parentNode as ShadowRoot | null);
    const same = p ? Array.from(p.children).filter((x) => x.tagName === e.tagName) : [];
    return e.tagName.toLowerCase() + (cls.length ? '.' + cls.join('.') : '') + (same.length > 1 ? ':nth-of-type(' + (same.indexOf(e) + 1) + ')' : '');
  };
  /** A shadow-piercing path to el: each host, then the steps inside el's own tree (up to eight), then its opening text, or a control's label. */
  const locOf = (el: Element): string => {
    const path: string[] = [];
    for (let e: Element | null = el; e && path.length < 8; e = e.parentElement) { if (e === document.body || e === document.documentElement) break; path.unshift(seg(e)); }
    const hosts: string[] = [];
    for (let r = el.getRootNode(); r.nodeType === 11; r = (r as ShadowRoot).host.getRootNode()) hosts.unshift(seg((r as ShadowRoot).host));
    const own = runsOf(el).map((r) => r.node.textContent || '').join(' ');
    const words = (own.trim() ? own : el.getAttribute('aria-label') || el.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 40);
    return [...hosts, path.join(' > ') || seg(el)].join(' >>> ') + (words ? ' "' + words + '"' : '');
  };
  const px = (n: number): number => Math.round(n * 100) / 100;
  /** m is under the threshold by more than layout's subpixel noise (0.05px). */
  const under = (m: number, t: number): boolean => m < t - 0.05;
  return { kids, ekids, boxKids, cparent, inside, desc, roots, qAll, shown, vis, isControl, runsOf, lineCount, rgb, surface, drawn, lightness, locOf, px, under };
}

export type AppHelpers = ReturnType<typeof glAppHelpers>;

/** The page before measuring: transitions off, running animations finished, fonts settled; which stylesheets and fonts did not load. */
export async function glAppSetup(P: AppProbes): Promise<AppSetupReport> {
  const quiet = document.createElement('style');
  quiet.textContent = '* { transition: none !important } html, body { scroll-behavior: auto !important }';
  document.head.appendChild(quiet);
  for (const a of document.getAnimations()) { try { a.finish(); } catch { /* an infinite animation keeps running */ } }
  if (document.fonts && document.fonts.status !== 'loaded') await Promise.race([document.fonts.ready, new Promise((r) => setTimeout(r, 3000))]);
  await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
  const lostSheets: string[] = [];
  for (const root of P.H.roots()) for (const l of root.querySelectorAll('link[rel~="stylesheet"][href]')) if (!(l as HTMLLinkElement).sheet) lostSheets.push((l.getAttribute('href') || '').split('?')[0].split('/').pop() || 'stylesheet');
  for (const e of performance.getEntriesByType('resource') as PerformanceResourceTiming[]) if ((e.initiatorType === 'link' || e.initiatorType === 'css') && /\.css(\?|$)/.test(e.name) && e.responseStatus >= 400) lostSheets.push(e.name.split('?')[0].split('/').pop() || 'stylesheet');
  const lostFonts: string[] = [];
  if (document.fonts) for (const f of document.fonts) if (f.status === 'error') lostFonts.push(f.family.replace(/^["']|["']$/g, ''));
  return { lostSheets: Array.from(new Set(lostSheets)), lostFonts: Array.from(new Set(lostFonts)) };
}

/** Every list under root: two or more adjacent siblings of one tag and class list (never headings, paragraphs, sections or forms), widths within 10%, stacked top to bottom, each holding text; never a table, a nav, a menu-like role or a grid of columns. */
export function glAppLists(P: AppProbes, root: Element): AppList[] {
  const { boxKids, cparent, vis, runsOf } = P.H;
  const out: AppList[] = [];
  const banned = (e: Element): boolean => {
    for (let n: Element | null = e; n; n = cparent(n)) if (/^(TABLE|THEAD|TBODY|TFOOT|TR|TD|TH|NAV)$/.test(n.tagName) || /^(navigation|grid|table|menu|menubar|listbox|tablist|tree)$/.test(n.getAttribute('role') || '')) return true;
    return false;
  };
  const walk = (parent: Element): void => {
    const kids = boxKids(parent).filter((k) => vis(k));
    const keyOf = (k: Element) => k.tagName + '|' + (k.getAttribute('class') || '').trim().split(/\s+/).filter(Boolean).sort().join(' ');
    const groups: Element[][] = [];
    for (const k of kids) {
      const g = groups[groups.length - 1];
      if (g && keyOf(g[0]) === keyOf(k)) g.push(k); else groups.push([k]);
    }
    for (const g of groups) {
      if (g.length < 2 || /^(H[1-6]|P|SECTION|MAIN|HEADER|FOOTER|ASIDE|FORM|FIELDSET)$/.test(g[0].tagName) || banned(g[0])) continue;
      const boxes = g.map((e) => e.getBoundingClientRect());
      const widths = boxes.map((b) => b.width);
      if (Math.max(...widths) > Math.min(...widths) * 1.1) continue;
      const order = g.map((e, i) => ({ e, b: boxes[i] })).sort((a, b) => a.b.top - b.b.top);
      if (order.some((x, i) => i > 0 && x.b.top < order[i - 1].b.bottom - 1)) continue;
      if (order.some((x) => !runsOf(x.e).length)) continue;
      const rows = order.map((x) => x.e);
      out.push({ container: parent, rows, last: rows[rows.length - 1], whole: kids.every((k) => rows.includes(k)) });
    }
    for (const k of kids) walk(k);
  };
  walk(root);
  return out;
}

/** row-crowding and note-in-row-weight over a list of rows (bounded: a row or the list draws an edge; or laid out: every row sets two or more boxes side by side), small-hit-area over any list's. */
export function glAppRows(P: AppProbes, list: AppList, vw: number): AppProbeFinding[] {
  const { runsOf, lineCount, surface, drawn, lightness, locOf, px, under, cparent, vis, desc, boxKids } = P.H;
  const out: AppProbeFinding[] = [];
  const rows = list.rows;
  const texts = rows.map((r) => runsOf(r));
  const boxes = rows.map((r) => r.getBoundingClientRect());
  const cb = list.container.getBoundingClientRect();
  const sideBySide = (r: Element): boolean => {
    if (!/flex|grid/.test(getComputedStyle(r).display)) return false;
    const bs = boxKids(r).filter((k) => vis(k)).map((k) => k.getBoundingClientRect());
    return bs.some((a, i) => bs.some((b, j) => j > i && a.top < b.bottom && b.top < a.bottom && (a.right <= b.left || b.right <= a.left)));
  };
  const bounded = surface(list.container) || rows.some((r) => surface(r)) || rows.every(sideBySide);
  const inner = (i: number, side: 'top' | 'bottom'): number | null => {
    const own = drawn(rows[i], side);
    if (own != null) return side === 'top' ? boxes[i].top + own : boxes[i].bottom - own;
    const j = side === 'top' ? i - 1 : i + 1;
    if (rows[j] && drawn(rows[j], side === 'top' ? 'bottom' : 'top') != null) return side === 'top' ? boxes[j].bottom : boxes[j].top;
    const c = !rows[j] && list.whole ? drawn(list.container, side) : null;
    return c == null ? null : side === 'top' ? cb.top + c : cb.bottom - c;
  };
  rows.forEach((row, i) => {
    const runs = texts[i];
    const lines = lineCount(runs);
    if (bounded && lines >= 2) {
      const topEdge = inner(i, 'top');
      const bottomEdge = inner(i, 'bottom');
      const top = topEdge == null ? Infinity : Math.min(...runs.map((r) => r.lineTop)) - topEdge;
      const bottom = bottomEdge == null ? Infinity : bottomEdge - Math.max(...runs.map((r) => r.lineBottom));
      const next = texts[i + 1];
      const gap = px(next && next.length ? Math.min(...next.map((r) => r.lineTop)) - Math.max(...runs.map((r) => r.lineBottom)) : Infinity);
      const edge = px(Math.min(top, bottom));
      if (under(edge, 8)) out.push({ rule: 'row-crowding', sentence: 'a ' + lines + '-line row leaves ' + edge + 'px between its text and its ' + (top <= bottom ? 'top' : 'bottom') + ' edge (under 8px)', locator: locOf(row), measured: edge, threshold: 8 });
      else if (under(gap, 16)) out.push({ rule: 'row-crowding', sentence: 'a ' + lines + '-line row leaves ' + gap + 'px between its last text line and the next row\'s text (under 16px)', locator: locOf(row), measured: gap, threshold: 16 });
    }
    if (bounded && runs.length) {
      const first = Math.min(...runs.map((r) => r.top));
      const name = runs.filter((r) => r.top <= first + 1).sort((a, b) => a.left - b.left)[0];
      const blocks = new Map<Element, typeof runs>();
      for (const r of runs) if (r.block !== name.block) blocks.set(r.block, [...(blocks.get(r.block) || []), r]);
      for (const [block, own] of blocks) {
        if (Math.min(...own.map((r) => r.top)) < name.bottom - 1) continue;
        let callout = false;
        for (let e: Element | null = block; e && e !== row; e = cparent(e)) if (surface(e)) { callout = true; break; }
        const ICON = 'svg, img, [aria-hidden="true"]';
        const iconed = !!block.querySelector(ICON) || [block.previousElementSibling, block.nextElementSibling].some((s) => !!s && vis(s) && (s.matches(ICON) || (!(s.textContent || '').trim() && !!s.querySelector('svg, img'))));
        if (callout || iconed) continue;
        const dl = Math.abs(lightness(own[0].el, row) - lightness(name.el, row));
        const ratio = parseFloat(getComputedStyle(own[0].el).fontSize) / parseFloat(getComputedStyle(name.el).fontSize);
        const noteLines = lineCount(own);
        if (dl < 0.15 && ratio >= 0.9) out.push({ rule: 'note-in-row-weight', sentence: 'a note in a row reads at the name\'s weight: lightness ' + dl.toFixed(3) + ' from the name\'s (under 0.15) at ' + ratio.toFixed(2) + ' of its size (0.9 or more)', locator: locOf(block), measured: Math.round(dl * 1000) / 1000, threshold: 0.15 });
        else if (vw >= 1200 && noteLines >= 3) out.push({ rule: 'note-in-row-weight', sentence: 'a note in a row runs ' + noteLines + ' lines at ' + vw + 'px (3 or more)', locator: locOf(block), measured: noteLines, threshold: 3 });
      }
    }
    if (vw <= 480) {
      const controls = desc(row).filter((c) => c !== row && c.matches('button, a[href], input:not([type=hidden]), select, [role=button], [role^=menuitem], [role=switch], [role=tab]') && vis(c));
      for (const c of controls) {
        if (c.tagName === 'A' && getComputedStyle(c).display === 'inline') {
          const host = cparent(c);
          if (host && runsOf(host).some((r) => !c.contains(r.node))) continue;
        }
        let b = c.getBoundingClientRect();
        const labels = (c as HTMLInputElement).labels;
        if (labels && labels.length) {
          const all = [b, ...Array.from(labels).map((l) => l.getBoundingClientRect())];
          const l = Math.min(...all.map((q) => q.left)), t = Math.min(...all.map((q) => q.top));
          b = new DOMRect(l, t, Math.max(...all.map((q) => q.right)) - l, Math.max(...all.map((q) => q.bottom)) - t);
        }
        if (under(b.width, 32) || under(b.height, 32)) out.push({ rule: 'small-hit-area', sentence: 'a row control is ' + px(b.width) + 'x' + px(b.height) + 'px at ' + vw + 'px (under 32px)', locator: locOf(c), measured: px(Math.min(b.width, b.height)), threshold: 32 });
      }
    }
  });
  return out;
}

/** copy-flush-under-list: the first text block after the list, before the next heading, inside the measured section. */
export function glAppAfter(P: AppProbes, list: AppList, root: Element): AppProbeFinding[] {
  const { boxKids, cparent, vis, runsOf, locOf, px, under } = P.H;
  const HEADING = /^H[1-6]$/;
  const isHeading = (e: Element) => HEADING.test(e.tagName) || e.getAttribute('role') === 'heading';
  let from: Element = list.whole ? list.container : list.last;
  for (let depth = 0; depth < 3; depth++) {
    let parent = cparent(from);
    while (parent && getComputedStyle(parent).display === 'contents' && parent !== root) parent = cparent(parent);
    if (!parent) return [];
    const sibs = boxKids(parent);
    for (const s of sibs.slice(sibs.indexOf(from) + 1)) {
      if (!vis(s)) continue;
      if (isHeading(s)) return [];
      const runs = runsOf(s);
      if (!runs.length) continue;
      const first = runs.slice().sort((a, b) => a.lineTop - b.lineTop)[0];
      for (let e: Element | null = first.el; e && e !== s; e = cparent(e)) if (isHeading(e)) return [];
      const gap = px(first.lineTop - from.getBoundingClientRect().bottom);
      return under(gap, 12) ? [{ rule: 'copy-flush-under-list', sentence: 'the text under the list starts ' + gap + 'px below it (under 12px)', locator: locOf(first.block), measured: gap, threshold: 12 }] : [];
    }
    if (parent === root || isHeading(parent)) return [];
    from = parent;
  }
  return [];
}

/** section-overflow: inside root, an element past the viewport's right edge, or a non-scrolling block wider inside than out. The innermost three. */
export function glAppOverflow(P: AppProbes, root: Element, vw: number): AppProbeFinding[] {
  const { ekids, vis, locOf, px } = P.H;
  const hits: Array<{ el: Element; sentence: string; m: number }> = [];
  const go = (el: Element, clipped: boolean): void => {
    if (el.tagName === 'svg' || /^(SCRIPT|STYLE|TEMPLATE)$/.test(el.tagName)) return;
    const cs = getComputedStyle(el);
    if (cs.display === 'contents') { for (const k of ekids(el)) go(k, clipped); return; }
    if (!vis(el) || cs.position === 'fixed') return;
    const b = el.getBoundingClientRect();
    if (!clipped && b.width > 1 && b.height > 1 && b.right > vw + 1) hits.push({ el, sentence: el.tagName.toLowerCase() + ' runs ' + px(b.right - vw) + 'px past the ' + vw + 'px viewport', m: px(b.right - vw) });
    else if (cs.overflowX === 'visible' && cs.display !== 'inline' && el.clientWidth > 0 && el.scrollWidth > el.clientWidth + 1) hits.push({ el, sentence: el.tagName.toLowerCase() + ' overflows its own box by ' + (el.scrollWidth - el.clientWidth) + 'px', m: el.scrollWidth - el.clientWidth });
    for (const k of ekids(el)) go(k, clipped || cs.overflowX !== 'visible');
  };
  go(root, false);
  const inner = hits.filter((h) => !hits.some((o) => o !== h && P.H.inside(o.el, h.el)));
  return inner.slice(0, 3).map((h) => ({ rule: 'section-overflow', sentence: h.sentence + ' (over 1px)', locator: locOf(h.el), measured: h.m, threshold: 1 }));
}

/** One state at one viewport: wait for the section and a list (or the caller's --wait-for), check the state's expect selector, then every app rule. */
export async function glAppMeasure(P: AppProbes, a: AppMeasureArgs): Promise<AppProbeResult> {
  const { qAll, inside, roots, desc } = P.H;
  const t0 = Date.now();
  const outermost = (els: Element[]) => els.filter((e) => !els.some((o) => o !== e && inside(e, o)));
  let matches: Element[] = [];
  let lists: AppList[] = [];
  let expectOk = true;
  let host: Element | undefined;
  const closed = (scope: Element[]): Element | undefined =>
    scope.flatMap((s) => desc(s)).find((e) => e.tagName.includes('-') && !e.shadowRoot && !e.children.length && !(e.textContent || '').trim() && e.getBoundingClientRect().height >= 40);
  for (;;) {
    matches = outermost(qAll(a.within));
    lists = matches.flatMap((m) => P.lists(P, m));
    expectOk = !a.expect || qAll(a.expect).length > 0;
    host = matches.length && !lists.length ? closed(matches) : undefined;
    if (host || (matches.length && (lists.length || a.explicitWait) && expectOk) || Date.now() - t0 > a.readyMs) break;
    await new Promise((r) => setTimeout(r, 150));
  }
  const matched = qAll(a.within).length;
  const nRoots = roots().length;
  const base = { matched, roots: nRoots, lists: lists.length, findings: [] as AppProbeFinding[] };
  if (!matches.length) {
    const host = closed([document.body]);
    if (host) return { ...base, status: 'incomplete', code: 'CLOSED_SHADOW', detail: '<' + host.tagName.toLowerCase() + '> renders a closed shadow root the lint cannot read, and nothing matched ' + a.within + ' in the document or its ' + (nRoots - 1) + ' open shadow roots' };
    return { ...base, status: 'incomplete', code: 'WITHIN_NO_MATCH', detail: 'nothing matched ' + a.within + ' in the document or its ' + (nRoots - 1) + ' open shadow roots' };
  }
  if (host) return { ...base, status: 'incomplete', code: 'CLOSED_SHADOW', detail: '<' + host.tagName.toLowerCase() + '> inside ' + a.within + ' renders a closed shadow root the lint cannot read' };
  if (!lists.length && !a.explicitWait) return { ...base, status: 'incomplete', code: 'NOT_READY', detail: 'no list of two or more rows appeared inside ' + a.within + ' within ' + Math.round(a.readyMs / 1000) + 's' };
  if (!expectOk) return { ...base, status: 'incomplete', code: 'STATE_MISMATCH', detail: 'the state\'s expect selector ' + a.expect + ' matched nothing after readiness' };
  const vw = innerWidth;
  const findings: AppProbeFinding[] = [];
  for (const l of lists) findings.push(...P.rows(P, l, vw), ...P.after(P, l, matches.find((m) => inside(l.container, m)) || l.container));
  for (const m of matches) findings.push(...P.overflow(P, m, vw));
  return { ...base, status: 'measured', findings };
}

const APP_FNS = { setup: glAppSetup, lists: glAppLists, rows: glAppRows, after: glAppAfter, overflow: glAppOverflow, measure: glAppMeasure };

export interface AppProbes extends AppFns { H: AppHelpers }
type AppFns = typeof APP_FNS;

export const APP_PROBE_GLOBAL = 'window.__gstackLintApp';

/** The JS that installs the app probes, as one expression. */
export function appInstallScript(): string {
  const entries = Object.entries(APP_FNS).map(([k, fn]) => k + ': (' + fn.toString() + ')');
  return '(' + APP_PROBE_GLOBAL + ' = { H: (' + glAppHelpers.toString() + ')(), ' + entries.join(', ') + ' }, 1)';
}

/** One app probe call as an eval expression: its JSON, or {error, stack} when it throws (the stack feeds the trace file). Written without the word await (see render-probe.ts probeScript). */
export function appProbeScript(call: string): string {
  return '(() => { const P = ' + APP_PROBE_GLOBAL + '; return Promise.resolve().then(() => (' + call + ')).then((v) => JSON.stringify(v), (e) => JSON.stringify({ error: String((e && e.message) || e).slice(0, 300), stack: String((e && e.stack) || e).slice(0, 4000) })); })()';
}

/** The readiness expression handed to the engine's waitFor: a selector matched through every open shadow root. With soft, it also turns true after ms, so a selector that never matches reaches the probe and reports WITHIN_NO_MATCH instead of failing the render. */
export function composedWaitExpression(selector: string, soft: number | null): string {
  const find = '(() => { const s = ' + JSON.stringify(selector) + '; const rs = [document]; try { for (let i = 0; i < rs.length; i++) { if (rs[i].querySelector(s)) return true; for (const e of rs[i].querySelectorAll("*")) if (e.shadowRoot) rs.push(e.shadowRoot); } } catch (e) { return ' + (soft != null) + '; } return false; })()';
  if (soft == null) return find;
  return '(() => { const w = window; w.__gstackLintAppWait = w.__gstackLintAppWait || Date.now(); return ' + find + ' || Date.now() - w.__gstackLintAppWait > ' + soft + '; })()';
}
