import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import { markdown } from "../web/markdown.ts";

// Exercise the same self-contained module served to browsers, without a DOM.
const bundle = await readFile(new URL("../web/assets/markdown.js", import.meta.url), "utf8");
const browser = await import(`data:text/javascript;base64,${Buffer.from(bundle).toString("base64")}`) as { markdown: typeof markdown };

for (const [name, render] of [["source", markdown], ["browser bundle", browser.markdown]] as const) {
  test(`${name}: soft breaks flow naturally and explicit breaks survive`, () => {
    assert.equal(render("第一行\n第二行"), "<p>第一行\n第二行</p>\n");
    assert.match(render("第一行  \n第二行"), /第一行<br>\n第二行/);
    assert.match(render("第一行\\\n第二行"), /第一行<br>\n第二行/);
    assert.equal(render("第一段\n\n第二段"), "<p>第一段</p>\n<p>第二段</p>\n");
  });

  test(`${name}: code and escaped punctuation remain literal`, () => {
    assert.equal(render("`**literal**`"), "<p><code>**literal**</code></p>\n");
    assert.match(render("``a ` b``"), /<code>a ` b<\/code>/);
    assert.match(render("\\*literal\\* and ~~old~~ and **bold *nested***"), /\*literal\* and <s>old<\/s> and <strong>bold <em>nested<\/em><\/strong>/);
  });

  test(`${name}: Chinese bold accepts punctuation next to Han characters`, () => {
    for (const text of ["加粗。", "“加粗”", "（重点）", "「重点」", "《文档》", "\"重点\""]) {
      assert.equal(render(`这是**${text}**后续`), `<p>这是<strong>${text.replaceAll('"', "&quot;")}</strong>后续</p>\n`);
    }
    assert.equal(render("𠀀**“重点”**𠀁"), "<p>𠀀<strong>“重点”</strong>𠀁</p>\n");
    assert.equal(render("这是**重点**。后续"), "<p>这是<strong>重点</strong>。后续</p>\n");
    assert.equal(render("这是**“重点”**以及**结论。**后续"), "<p>这是<strong>“重点”</strong>以及<strong>结论。</strong>后续</p>\n");
    assert.equal(render("这是**“含有*斜体*”**后续"), "<p>这是<strong>“含有<em>斜体</em>”</strong>后续</p>\n");
    assert.match(render("[这是**“重点”**链接](https://example.com)"), /这是<strong>“重点”<\/strong>链接<\/a>/);
  });

  test(`${name}: list labels with Chinese punctuation support English and numeric continuations`, () => {
    for (const [label, suffix] of [
      ["重点", " 说明"], ["重点：", "后续"], ["重点：", "English"],
      ["数量：", "123"], ["说明（推荐）", "API"], ["“重点”", "English"],
    ]) {
      assert.equal(render(`- **${label}**${suffix}`), `<ul>\n<li><strong>${label}</strong>${suffix}</li>\n</ul>\n`);
    }
    assert.equal(render("- API**“重点”**v2"), "<ul>\n<li>API<strong>“重点”</strong>v2</li>\n</ul>\n");
    assert.equal(render("- **重点：**English\n- **数量：**123"), "<ul>\n<li><strong>重点：</strong>English</li>\n<li><strong>数量：</strong>123</li>\n</ul>\n");
    assert.equal(render("- 外层\n  - **重点：**English"), "<ul>\n<li>外层\n<ul>\n<li><strong>重点：</strong>English</li>\n</ul>\n</li>\n</ul>\n");
    assert.match(render("> - **重点：**English"), /<blockquote>\n<ul>\n<li><strong>重点：<\/strong>English<\/li>/);
    assert.match(render("- [x] **重点：**English"), /<strong>重点：<\/strong>English<\/li>/);
    assert.equal(render("- **重点：**English，**数量：**123"), "<ul>\n<li><strong>重点：</strong>English，<strong>数量：</strong>123</li>\n</ul>\n");
  });

  test(`${name}: Chinese bold compatibility preserves literal text and delimiter boundaries`, () => {
    for (const text of ["这是** 加粗 **后续", "这是**加粗。", "word**bold.**word", "这是*“斜体”*后续", "这是__“加粗”__后续"]) {
      assert.equal(render(text), `<p>${text}</p>\n`);
    }
    assert.equal(render("`这是**“重点”**后续`"), "<p><code>这是**“重点”**后续</code></p>\n");
    assert.equal(render(String.raw`这是\*\*“重点”\*\*后续`), "<p>这是**“重点”**后续</p>\n");
    assert.match(render("```text\n这是**“重点”**后续\n```"), /这是\*\*“重点”\*\*后续/);
    assert.equal(render("这是**“重点”"), "<p>这是**“重点”</p>\n");
    assert.equal(render("这是**“重点”**后续"), "<p>这是<strong>“重点”</strong>后续</p>\n");
  });

  test(`${name}: fenced code keeps its language, highlights, and tolerates incomplete streaming fences`, () => {
    assert.match(render("```js\nconst x = 1;\n```"), /md-code-language">js<\/div>/);
    assert.match(render("```js\nconst x = 1;"), /hljs-keyword">const<\/span>/);
    assert.match(render("~~~python\nprint('ok')\n~~~"), /hljs-built_in">print<\/span>/);
    assert.match(render('```unknown\n<script>alert("x")</script>\n```'), /&lt;script&gt;alert\(&quot;x&quot;\)&lt;\/script&gt;/);
    assert.doesNotMatch(render('```js\n' + 'const x = 1;\n'.repeat(3000)), /class="hljs-keyword"/);
  });

  test(`${name}: task lists, nested quotes and tables preserve structure`, () => {
    const tasks = render("- [x] **已完成**\n- [ ] 待处理\n  - [X] 子项");
    assert.equal((tasks.match(/class="md-task-item"/g) || []).length, 3);
    assert.equal((tasks.match(/disabled checked/g) || []).length, 2);
    assert.match(tasks, /<strong>已完成<\/strong>/);
    assert.match(render("> 第一段\n>\n> - 子项\n> - **重点**"), /<blockquote>\n<p>第一段<\/p>\n<ul>/);
    const table = render("| 名称 | 数量 |\n| :--- | ---: |\n| **结果** | 12 |\n| a\\|b | 3 |");
    assert.match(table, /class="md-table-wrap"><table>/);
    assert.match(table, /<th style="text-align:right">数量<\/th>/);
    assert.match(table, /<td style="text-align:left">a\|b<\/td>/);
  });

  test(`${name}: images render with alt text, links retain inline formatting`, () => {
    assert.match(render('![示例](https://example.com/image.png "说明")'), /<img src="https:\/\/example.com\/image.png" alt="示例" title="说明" loading="lazy" decoding="async" referrerpolicy="no-referrer">/);
    assert.match(render('[**文档**](https://example.com/docs_(v2))'), /href="https:\/\/example.com\/docs_\(v2\)".*?<strong>文档<\/strong><\/a>/);
  });

  test(`${name}: local images use the image endpoint for Windows paths and file URLs`, () => {
    for (const [target, path] of [
      ["D:/project/screenshot.png", "D:/project/screenshot.png"],
      ["/D:/project/screenshot.png", "D:/project/screenshot.png"],
      ["<D:/My Project/主题截图.png>", "D:/My Project/主题截图.png"],
      ["file:///D:/My%20Project/%E4%B8%BB%E9%A2%98.png", "D:/My Project/主题.png"],
    ]) {
      const html = render(`![截图](${target})`);
      assert.ok(html.includes(`src="/api/fs/view?path=${encodeURIComponent(path)}&amp;format=image"`), html);
      assert.match(html, /alt="截图"/);
      assert.doesNotMatch(html, /class="md-local-file"/);
    }
    assert.match(render("![图](/assets/example.png)"), /src="\/assets\/example.png"/);
  });

  test(`${name}: local file links preserve paths and line numbers`, () => {
    for (const [target, path, line] of [
      ["D:/project/file.ts:12", "D:/project/file.ts", "12"],
      ["<D:/My Project/说明.md#L20>", "D:/My Project/说明.md", "20"],
      ["file:///D:/My%20Project/file.ts#L5C2", "D:/My Project/file.ts", "5"],
    ]) {
      const html = render(`[文件](${target})`);
      assert.ok(html.includes(`data-file-path="${path}"`), html);
      assert.ok(html.includes(`data-file-line="${line}"`), html);
      assert.ok(html.includes(`/api/fs/view?path=${encodeURIComponent(path)}#L${line}`), html);
    }
    assert.match(render('[`file.ts`](D:/project/file.ts)'), /<code>file.ts<\/code><\/a>/);
  });

  test(`${name}: raw HTML and unsafe URLs cannot create executable markup`, () => {
    const html = render('<script>alert(1)</script>\n\n<img src=x onerror=alert(1)>\n\n[x](javascript:alert(1))\n\n![x](data:text/html;base64,PHNjcmlwdD4=)\n\n[x](jav&#x61;script:alert(1))');
    assert.doesNotMatch(html, /<script|<img|href="javascript:|src="data:text\/html/);
    assert.match(html, /&lt;script&gt;/);
  });
}
