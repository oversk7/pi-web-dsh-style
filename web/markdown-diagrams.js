let renderer;
let configuredTheme;
let sequence = 0;
const cache = new Map();
const rendered = new WeakMap();

function diagramFragment(template) {
  const content = template.content.cloneNode(true);
  const prefix = `pi-diagram-${++sequence}`;
  const ids = new Map();
  for (const element of content.querySelectorAll("[id]")) {
    const original = element.id;
    const unique = `${prefix}-${ids.size}`;
    ids.set(original, unique);
    element.id = unique;
  }
  const replaceUrls = value => value.replace(/url\(\s*(["']?)#([^\s)"']+)\1\s*\)/g,
    (match, quote, id) => ids.has(id) ? `url(${quote}#${ids.get(id)}${quote})` : match);
  for (const element of content.querySelectorAll("*")) {
    for (const attribute of [...element.attributes]) {
      let value = replaceUrls(attribute.value);
      if (["href", "xlink:href"].includes(attribute.name) && value.startsWith("#") && ids.has(value.slice(1))) {
        value = `#${ids.get(value.slice(1))}`;
      }
      if (["aria-labelledby", "aria-describedby"].includes(attribute.name)) {
        value = value.split(/\s+/).map(id => ids.get(id) || id).join(" ");
      }
      if (value !== attribute.value) element.setAttribute(attribute.name, value);
    }
    if (element.localName === "style") {
      element.textContent = replaceUrls(element.textContent).replace(/#([\w:.-]+)/g,
        (match, id) => ids.has(id) ? `#${ids.get(id)}` : match);
    }
  }
  return content;
}

export function observeMarkdownDiagrams(root = document.body) {
  let frame;
  let running = false;
  let stopped = false;
  const pending = new Set();
  const selector = '.md-mermaid[data-mermaid-complete="true"]';

  function collect(node) {
    if (node.nodeType !== 1) return;
    if (node.matches(selector)) pending.add(node);
    for (const diagram of node.querySelectorAll(selector)) pending.add(diagram);
    if (pending.size) schedule();
  }

  async function update() {
    frame = undefined;
    if (running || stopped) return;
    running = true;
    try {
      for (const node of [...pending]) {
        pending.delete(node);
        const dark = document.body.hasAttribute("data-ds-dark-theme");
        const source = node.dataset.mermaidSource || "";
        const key = `${dark}:${source}`;
        if (rendered.get(node) === key || !node.isConnected) continue;
        rendered.set(node, key);
        if (source.length > 32 * 1024) continue;
        try {
          let result = cache.get(key);
          if (!result) {
            renderer ||= import("./assets/mermaid/mermaid.js").then(module => module.default).catch(error => {
              renderer = undefined;
              throw error;
            });
            const mermaid = await renderer;
            if (!node.isConnected || stopped) continue;
            if (dark !== document.body.hasAttribute("data-ds-dark-theme")) {
              rendered.delete(node);
              pending.add(node);
              continue;
            }
            if (configuredTheme !== dark) mermaid.initialize({
              startOnLoad: false,
              securityLevel: "strict",
              theme: dark ? "dark" : "default",
              layout: "dagre",
              suppressErrorRendering: true,
              maxTextSize: 32 * 1024,
              flowchart: { htmlLabels: false },
            });
            configuredTheme = dark;
            const id = `pi-mermaid-${++sequence}`;
            let svg;
            try {
              ({ svg } = await mermaid.render(id, source));
            } catch {
              result = { error: true };
            }
            if (!result) {
              const template = document.createElement("template");
              template.innerHTML = svg;
              result = { template };
            }
            cache.set(key, result);
            if (cache.size > 64) cache.delete(cache.keys().next().value);
          }
          if (!node.isConnected || stopped) continue;
          if (dark !== document.body.hasAttribute("data-ds-dark-theme")) {
            rendered.delete(node);
            pending.add(node);
            continue;
          }
          if (result.error) {
            node.dataset.mermaidState = "error";
            continue;
          }
          node.replaceChildren(diagramFragment(result.template));
          node.dataset.mermaidState = "rendered";
          node.setAttribute("role", "img");
          node.setAttribute("aria-label", "Mermaid diagram");
        } catch {
          // Keep the readable source when a diagram is invalid or still incomplete.
          node.dataset.mermaidState = "error";
        }
      }
    } finally {
      running = false;
      if (pending.size) schedule();
    }
  }

  function schedule() {
    if (!stopped && frame === undefined) frame = requestAnimationFrame(update);
  }

  const observer = new MutationObserver(records => {
    for (const record of records) {
      if (record.type === "attributes") collect(root);
      else for (const node of record.addedNodes) collect(node);
    }
  });
  observer.observe(root, { childList: true, subtree: true, attributes: true, attributeFilter: ["data-ds-dark-theme"] });
  collect(root);
  return () => {
    stopped = true;
    observer.disconnect();
    if (frame !== undefined) cancelAnimationFrame(frame);
    pending.clear();
  };
}
