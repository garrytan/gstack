() => {
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
}
