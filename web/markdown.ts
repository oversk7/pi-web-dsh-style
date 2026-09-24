import MarkdownIt from "markdown-it";
import hljs from "highlight.js/lib/common";
import dockerfile from "highlight.js/lib/languages/dockerfile";
import powershell from "highlight.js/lib/languages/powershell";

hljs.registerLanguage("dockerfile", dockerfile);
hljs.registerLanguage("powershell", powershell);

function localFileLink(target: string) {
  let value = target.trim();
  let line: number | null = null;
  const location = /#L(\d+)(?:C\d+)?$/i.exec(value) || /:(\d+)(?::\d+)?$/.exec(value);
  if (location) {
    line = Number(location[1]);
    value = value.slice(0, location.index);
  }
  if (/^file:\/\/\//i.test(value)) {
    try {
      value = decodeURIComponent(new URL(value).pathname).replace(/^\/([A-Za-z]:[\\/])/, "$1");
    } catch {
      return null;
    }
  }
  value = value.replace(/^\/([A-Za-z]:[\\/])/, "$1");
  if (!/^[A-Za-z]:[\\/]/.test(value) && !/^\\\\[^\\]+\\[^\\]+/.test(value)) return null;
  const href = `/api/fs/view?path=${encodeURIComponent(value)}${line ? `#L${line}` : ""}`;
  return { path: value, line, href };
}

const parser = new MarkdownIt({ html: false, breaks: false, linkify: true });
const InlineState = parser.inline.State;
parser.inline.State = class extends InlineState {
  scanDelims(start: number, canSplitWord: boolean) {
    const scanned = super.scanDelims(start, canSplitWord);
    if (this.src[start] !== "*" || scanned.length < 2) return scanned;
    const before = this.src.slice(Math.max(0, start - 2), start);
    const end = start + scanned.length;
    const after = end < this.posMax ? String.fromCodePoint(this.src.codePointAt(end)!) : "";
    // Chinese punctuation can border emphasis even beside Latin text or numbers.
    const cjkPunctuation = /[\u2000-\u206f\u3000-\u303f\uff00-\uffef]/u;
    if (/^\p{P}/u.test(after) && (cjkPunctuation.test(after) || /\p{Script=Han}$/u.test(before))) scanned.can_open = true;
    if (/\p{P}$/u.test(before) && (cjkPunctuation.test(before.slice(-1)) || /^\p{Script=Han}/u.test(after))) scanned.can_close = true;
    return scanned;
  }
};
const escape = parser.utils.escapeHtml;
const normalizeLink = parser.normalizeLink;
const validateLink = parser.validateLink;
parser.normalizeLink = (target) => localFileLink(target) ? target : normalizeLink(target);
parser.validateLink = (target) => Boolean(localFileLink(target)) || validateLink(target);

parser.renderer.rules.link_open = (tokens, index, options, env, renderer) => {
  const token = tokens[index];
  const target = String(token.attrGet("href") || "");
  const local = localFileLink(target);
  if (local) {
    token.attrSet("href", local.href);
    token.attrJoin("class", "md-local-file");
    token.attrSet("data-file-path", local.path);
    token.attrSet("data-file-line", local.line ? String(local.line) : "");
    token.attrSet("title", `${local.path}${local.line ? `:${local.line}` : ""}`);
  } else if (/^https?:\/\//i.test(target)) {
    token.attrSet("target", "_blank");
    token.attrSet("rel", "noopener noreferrer");
  }
  return renderer.renderToken(tokens, index, options);
};

const renderImage = parser.renderer.rules.image!;
parser.renderer.rules.image = (tokens, index, options, env, renderer) => {
  const local = localFileLink(String(tokens[index].attrGet("src") || ""));
  if (local) tokens[index].attrSet("src", `/api/fs/view?path=${encodeURIComponent(local.path)}&format=image`);
  tokens[index].attrSet("loading", "lazy");
  tokens[index].attrSet("decoding", "async");
  tokens[index].attrSet("referrerpolicy", "no-referrer");
  return renderImage(tokens, index, options, env, renderer);
};

parser.renderer.rules.fence = (tokens, index) => {
  const token = tokens[index];
  const language = token.info.trim().split(/\s+/)[0];
  let code = escape(token.content);
  // Bound synchronous highlighting work while streaming large tool-generated snippets.
  if (language && hljs.getLanguage(language) && token.content.length <= 32 * 1024) {
    code = hljs.highlight(token.content, { language, ignoreIllegals: true }).value;
  }
  const label = language ? `<div class="md-code-language">${escape(language)}</div>` : "";
  return `<div class="md-code-container">${label}<pre class="md-code-block"><code class="hljs">${code}</code></pre></div>\n`;
};
parser.renderer.rules.code_block = (tokens, index) => `<pre class="md-code-block"><code>${escape(tokens[index].content)}</code></pre>\n`;
parser.renderer.rules.table_open = () => '<div class="md-table-wrap"><table>\n';
parser.renderer.rules.table_close = () => '</table></div>\n';

parser.core.ruler.after("inline", "task_lists", (state) => {
  for (let i = 2; i < state.tokens.length; i += 1) {
    const token = state.tokens[i];
    const paragraph = state.tokens[i - 1];
    const item = state.tokens[i - 2];
    if (token.type !== "inline" || paragraph.type !== "paragraph_open" || item.type !== "list_item_open") continue;
    const first = token.children?.[0];
    if (first?.type !== "text") continue;
    const match = /^\[([ xX])\](?:\s+|$)/.exec(first.content);
    if (!match) continue;
    first.content = first.content.slice(match[0].length);
    const checkbox = new state.Token("task_checkbox", "input", 0);
    checkbox.meta = { checked: match[1].toLowerCase() === "x" };
    token.children!.unshift(checkbox);
    item.attrJoin("class", "md-task-item");
  }
});
parser.renderer.rules.task_checkbox = (tokens, index) => {
  const checked = tokens[index].meta!.checked;
  return `<input type="checkbox" disabled${checked ? " checked" : ""} aria-label="${checked ? "已完成" : "未完成"}"/> `;
};

export function markdown(src: unknown): string {
  return parser.render(String(src ?? ""));
}
