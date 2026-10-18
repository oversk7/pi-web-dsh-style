import { build } from "esbuild";
import { readFile, writeFile, readdir, cp, rm } from "node:fs/promises";
import { fileURLToPath } from "node:url";

const root = new URL("../", import.meta.url);
await build({
  absWorkingDir: fileURLToPath(root),
  entryPoints: ["web/markdown.ts"],
  outfile: "web/assets/markdown.js",
  bundle: true,
  format: "esm",
  platform: "browser",
  target: "es2022",
  minify: true,
  legalComments: "none",
  banner: { js: "/*! Bundled Markdown renderer. Licenses: markdown.LICENSE.txt */" },
});

await rm(new URL("web/assets/mermaid/", root), { recursive: true, force: true });
await build({
  absWorkingDir: fileURLToPath(root),
  entryPoints: { mermaid: fileURLToPath(import.meta.resolve("mermaid")) },
  outdir: "web/assets/mermaid",
  chunkNames: "chunks/[name]-[hash]",
  bundle: true,
  splitting: true,
  format: "esm",
  platform: "browser",
  target: "es2022",
  minify: true,
  legalComments: "linked",
});
await rm(new URL("web/assets/mermaid.js", root), { force: true });
await rm(new URL("web/assets/mermaid.js.LEGAL.txt", root), { force: true });
await cp(new URL("node_modules/katex/dist/katex.min.css", root), new URL("web/assets/katex.min.css", root));
await cp(new URL("node_modules/katex/dist/fonts/", root), new URL("web/assets/fonts/", root), { recursive: true });

const packages = ["markdown-it", "entities", "linkify-it", "mdurl", "punycode.js", "uc.micro", "highlight.js", "katex", "markdown-it-texmath", "mermaid"];
const licenses = [];
for (const name of packages) {
  const directory = new URL(`node_modules/${name}/`, root);
  const filename = (await readdir(directory)).find((file) => /^license(?:[.-]|$)/i.test(file));
  if (!filename) throw new Error(`Missing license: ${name}`);
  licenses.push(`${name}\n${await readFile(new URL(filename, directory), "utf8")}`);
}
await writeFile(new URL("web/assets/markdown.LICENSE.txt", root), licenses.join("\n\n---\n\n"));
