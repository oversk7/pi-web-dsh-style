declare module "markdown-it-texmath" {
  import type MarkdownIt from "markdown-it";
  import type { KatexOptions } from "katex";

  interface TexmathOptions {
    engine: { renderToString(source: string, options: KatexOptions): string };
    delimiters: string[];
    katexOptions?: KatexOptions;
  }

  export default function texmath(parser: MarkdownIt, options: TexmathOptions): void;
}
