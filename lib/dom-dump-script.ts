// lib/dom-dump-script.ts — the rendered-DOM dump script design-review evaluates
// in the page before handing the result to the design detector.
//
// Pure module: no I/O, no imports from scripts/. Consumers:
//   scripts/resolvers/design.ts   Phase 3 prose tells the agent to load lib/dom-dump.js
//   lib/dom-dump.js               committed copy gen-skill-docs writes; the engines load it at runtime
//   test/fixtures/*.dom.html      captured by running it through the browse engine
//   test/impeccable-fixtures.test.ts  pins that the committed dump came from THIS script
//
// Contract (one script, two engines):
//   - An arrow-FUNCTION expression, never a self-calling IIFE: Aside's
//     `pg.evaluate(fn)` receives the function and runs it in the page (an IIFE
//     would execute in the repl sandbox, where there is no `document`), and the
//     fallback engine calls it with `$B js "($_DUMP)()"`. Both splice the file's
//     text into bash, so it contains NO single quotes, no backticks, and no `${`.
//   - Works on a CLONE of document.documentElement, never the live page.
//   - Inlines only the stylesheets a <link> owns (inline <style> nodes are
//     already in the markup; re-serializing them double-counts) as one
//     <style data-gstack-dom-css> in <head>, and removes each inlined <link>
//     from the clone so the static engine does not try to resolve its href
//     relative to the dump file. Cross-origin sheets throw on cssRules access,
//     stay as <link>, and are listed in the trailing HTML comment.
//   - The CSSOM serializes author hex colors as rgb(r, g, b); the engine's
//     palette rules (ai-color-palette, cream-palette, ...) match hex literals,
//     so opaque rgb() triples are folded back to #rrggbb. Verified on engine
//     0.1.3: without this fold the DOM dump loses ai-color-palette.
//   - Hygiene before the file leaves the browser: <script> bodies emptied,
//     <input>/<textarea> values dropped, `value=` and `data-*` attributes over
//     32 chars emptied, <meta content> emptied (charset and viewport kept: they
//     carry no user data and the viewport hint is layout-relevant), query
//     strings cut from every URL-bearing attribute (href, src, srcset, poster,
//     action, formaction, data, ping, cite: signed CDN and form URLs carry
//     tokens), data: URLs over 1 KB replaced by a placeholder in attributes, in
//     the inlined CSS, and in existing <style> nodes.
//   - The trailing comment names what the dump cannot contain (shadow DOM,
//     constructed stylesheets, runtime-injected styles when scripts were
//     stripped) so the report can say so once. <template> and <noscript>
//     subtrees (invisible to the querySelectorAll walk) and inline on*
//     handlers are removed; cross-origin <link> nodes leave the clone too,
//     so the file handed to the engine names no remote stylesheet. CSS url()
//     query strings (signed asset URLs) are cut in style attributes, <style>
//     nodes, and the inlined sheets; srcdoc is emptied.
export const DOM_DUMP_SCRIPT = String.raw`() => {
  const root = document.documentElement.cloneNode(true);
  const head = root.querySelector("head") || root;
  const inlined = [];
  const crossOrigin = [];
  const liveLinks = Array.from(document.querySelectorAll("link"));
  const cloneLinks = Array.from(root.querySelectorAll("link"));
  liveLinks.forEach((link, i) => {
    const sheet = link.sheet;
    if (!sheet) return;
    if (link.disabled || (link.getAttribute("rel") || "").indexOf("alternate") !== -1) {
      if (cloneLinks[i]) cloneLinks[i].remove(); // not active CSS: never scanned as page styles
      return;
    }
    try {
      let text = Array.from(sheet.cssRules).map((rule) => rule.cssText).join("\n");
      const media = sheet.media && sheet.media.mediaText;
      if (media && media !== "all") text = "@media " + media + " {\n" + text + "\n}"; // a print sheet stays a print sheet
      inlined.push("/* gstack-dom-dump: " + (sheet.href || "link") + " */\n" + text);
      if (cloneLinks[i]) cloneLinks[i].remove();
    } catch (err) {
      crossOrigin.push(sheet.href || "(unknown)");
      if (cloneLinks[i]) cloneLinks[i].remove();
    }
  });
  const dataUrl = new RegExp("url\\((\"?)data:[^)]{1024,}\\)", "g");
  const cssQuery = new RegExp("url\\(\\s*([\"\u0027]?)([^\u0027\")?#]*)[?#][^\u0027\")]*\\1\\s*\\)", "g");
  const cleanCss = (t) => t.replace(dataUrl, "url(data:,gstack-stripped)").replace(cssQuery, "url($1$2$1)");
  if (inlined.length) {
    const style = document.createElement("style");
    style.setAttribute("data-gstack-dom-css", "");
    const rgb = new RegExp("rgb\\((\\d+), (\\d+), (\\d+)\\)", "g");
    const hex = (n) => Number(n).toString(16).padStart(2, "0");
    style.textContent = cleanCss(inlined.join("\n"))
      .replace(rgb, (m, r, g, b) => "#" + hex(r) + hex(g) + hex(b));
    head.appendChild(style);
  }
  for (const el of Array.from(root.querySelectorAll("style"))) {
    if (el.getAttribute("data-gstack-dom-css") === null && el.textContent) el.textContent = cleanCss(el.textContent);
  }
  const urlAttrs = ["href", "src", "poster", "action", "formaction", "data", "ping", "cite", "background", "xlink:href"];
  const cutQuery = (v) => v.split("?")[0].split("#")[0];
  let scripts = 0;
  for (const el of Array.from(root.querySelectorAll("script"))) {
    if (el.textContent) { el.textContent = ""; scripts += 1; }
  }
  for (const el of Array.from(root.querySelectorAll("textarea"))) el.textContent = "";
  for (const el of Array.from(root.querySelectorAll("template, noscript"))) el.remove();
  for (const el of Array.from(root.querySelectorAll("*"))) {
    for (const attr of Array.from(el.attributes)) {
      const name = attr.name;
      const value = attr.value;
      if (name.indexOf("on") === 0) el.removeAttribute(name);
      else if (name === "srcdoc") el.setAttribute(name, "");
      else if (name === "style") el.setAttribute(name, cleanCss(value));
      else if (name === "value" && (el.nodeName === "INPUT" || el.nodeName === "TEXTAREA")) el.setAttribute(name, "");
      else if ((name === "value" || name.indexOf("data-") === 0) && value.length > 32) el.setAttribute(name, "");
      else if (name === "content" && el.nodeName === "META" && el.getAttribute("name") !== "viewport") el.setAttribute(name, "");
      else if (name === "srcset") el.setAttribute(name, value.split(",").map((c) => { const parts = c.trim().split(/\s+/); parts[0] = cutQuery(parts[0] || ""); return parts.join(" "); }).join(", "));
      else if (urlAttrs.indexOf(name) !== -1 && (value.indexOf("?") !== -1 || value.indexOf("#") !== -1) && value.indexOf("data:") !== 0) el.setAttribute(name, cutQuery(value));
      else if (value.indexOf("data:") === 0 && value.length > 1024) el.setAttribute(name, "data:,gstack-stripped");
    }
  }
  const notes = ["shadow DOM and constructed stylesheets not captured"];
  if (crossOrigin.length) notes.push("cross-origin stylesheets not resolved: " + crossOrigin.join(" "));
  if (scripts) notes.push("scripts stripped: " + scripts + "; styles injected at runtime not captured");
  return "<!DOCTYPE html>\n" + root.outerHTML + "\n<!-- gstack-dom-dump: " + notes.join("; ") + " -->\n";
}`;

/**
 * Committed copy of DOM_DUMP_SCRIPT for the browser engines to load at runtime
 * (written by gen-skill-docs, pinned byte-equal by test/impeccable-fixtures.test.ts).
 * Skills `cat` it into an Aside script or `cp` it beside `$B eval`; the prose
 * never carries the script text.
 */
export const DOM_DUMP_FILE = 'lib/dom-dump.js';

/** Marker the dump script leaves on the inlined-stylesheet node. */
export const DOM_DUMP_STYLE_ATTR = 'data-gstack-dom-css';
/** Prefix of the trailing HTML comment the dump script appends. */
export const DOM_DUMP_NOTE_PREFIX = 'gstack-dom-dump:';
