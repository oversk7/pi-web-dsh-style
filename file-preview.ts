import { basename, extname } from "node:path";
import hljs from "highlight.js/lib/common";
import dockerfile from "highlight.js/lib/languages/dockerfile";
import powershell from "highlight.js/lib/languages/powershell";

hljs.registerLanguage("dockerfile", dockerfile);
hljs.registerLanguage("powershell", powershell);

const MAX_HIGHLIGHT_BYTES = 512 * 1024;

const LANGUAGES_BY_EXTENSION: Record<string, string> = {
  ".bash": "bash",
  ".c": "c",
  ".cc": "cpp",
  ".cjs": "javascript",
  ".cpp": "cpp",
  ".cs": "csharp",
  ".css": "css",
  ".cts": "typescript",
  ".go": "go",
  ".h": "c",
  ".hpp": "cpp",
  ".htm": "xml",
  ".html": "xml",
  ".java": "java",
  ".js": "javascript",
  ".json": "json",
  ".jsonc": "json",
  ".jsx": "javascript",
  ".md": "markdown",
  ".mdx": "markdown",
  ".mjs": "javascript",
  ".mts": "typescript",
  ".ps1": "powershell",
  ".psd1": "powershell",
  ".psm1": "powershell",
  ".py": "python",
  ".rs": "rust",
  ".sh": "bash",
  ".sql": "sql",
  ".svg": "xml",
  ".ts": "typescript",
  ".tsx": "typescript",
  ".xml": "xml",
  ".yaml": "yaml",
  ".yml": "yaml",
};

const LANGUAGES_BY_FILENAME: Record<string, string> = {
  dockerfile: "dockerfile",
  makefile: "makefile",
};

export interface FilePreviewData {
  path: string;
  name: string;
  language: string;
  highlighted: boolean;
  highlightedHtml: string;
  lineCount: number;
  size: number;
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>]/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" })[char]!);
}

export function buildFilePreview(filePath: string, data: Buffer): FilePreviewData {
  const name = basename(filePath);
  const text = data.toString("utf8").replace(/^\uFEFF/, "").replace(/\r\n?/g, "\n");
  const language = LANGUAGES_BY_FILENAME[name.toLowerCase()] ?? LANGUAGES_BY_EXTENSION[extname(name).toLowerCase()] ?? "plaintext";
  const canHighlight = data.byteLength <= MAX_HIGHLIGHT_BYTES && Boolean(hljs.getLanguage(language));
  let highlightedHtml = escapeHtml(text);
  let highlighted = false;

  if (canHighlight) {
    try {
      highlightedHtml = hljs.highlight(text, { language, ignoreIllegals: true }).value;
      highlighted = true;
    } catch {
      // Plain escaped text remains readable when a grammar rejects the input.
    }
  }

  return {
    path: filePath,
    name,
    language,
    highlighted,
    highlightedHtml,
    lineCount: text.split("\n").length,
    size: data.byteLength,
  };
}
