import { extname, posix } from "node:path";
import { fileURLToPath } from "node:url";
import { unzipSync } from "fflate";
import { XMLParser, XMLValidator } from "fast-xml-parser";

const MAX_TEXT = 200_000;
const MAX_XML_BYTES = 32 * 1024 * 1024;
const OFFICE_MIME: Record<string, string> = {
  ".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  ".xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  ".pptx": "application/vnd.openxmlformats-officedocument.presentationml.presentation",
};

type XmlNode = { [key: string]: XmlNode[] | Record<string, string> | string };
const parser = new XMLParser({ preserveOrder: true, ignoreAttributes: false, attributeNamePrefix: "", parseTagValue: false, parseAttributeValue: false, trimValues: false });

function tag(node: XmlNode): string {
  return Object.keys(node).find((key) => key !== ":@") ?? "";
}
function children(node: XmlNode): XmlNode[] {
  const value = node[tag(node)];
  return Array.isArray(value) ? value : [];
}
function attr(node: XmlNode, name: string): string {
  return (node[":@"] as Record<string, string> | undefined)?.[name] ?? "";
}
function find(nodes: XmlNode[], name: string): XmlNode[] {
  const found: XmlNode[] = [];
  for (const node of nodes) {
    if (tag(node).split(":").at(-1) === name) found.push(node);
    else found.push(...find(children(node), name));
  }
  return found;
}
function value(nodes: XmlNode[]): string {
  return nodes.map((node) => tag(node) === "#text" ? String(node["#text"]) : value(children(node))).join("");
}
function runs(nodes: XmlNode[]): string {
  return nodes.map((node) => {
    const name = tag(node).split(":").at(-1);
    if (name === "t") return value(children(node));
    if (name === "tab") return "\t";
    if (name === "br" || name === "cr") return "\n";
    return runs(children(node));
  }).join("");
}
function checked(text: string): string {
  if (text.length > MAX_TEXT) throw new Error("解析文本超过 200000 字符，请拆分文件后上传");
  return text;
}
function decode(bytes: Uint8Array): string {
  const encoding = bytes[0] === 0xff && bytes[1] === 0xfe ? "utf-16le"
    : bytes[0] === 0xfe && bytes[1] === 0xff ? "utf-16be" : "utf-8";
  try {
    return new TextDecoder(encoding, { fatal: true }).decode(bytes);
  } catch {
    throw new Error("文件编码无效，仅支持 UTF-8 或带 BOM 的 UTF-16 文本");
  }
}

function officeFiles(bytes: Uint8Array): Record<string, Uint8Array> {
  let total = 0;
  try {
    const files = unzipSync(bytes, { filter(entry) {
      if (!/\.(xml|rels)$/i.test(entry.name)) return false;
      total += entry.originalSize;
      if (total > MAX_XML_BYTES) throw new Error("Office XML 解压总量超过 32MB");
      return true;
    } });
    if (Object.values(files).reduce((sum, file) => sum + file.length, 0) > MAX_XML_BYTES) throw new Error("Office XML 解压总量超过 32MB");
    return files;
  } catch (error) {
    throw new Error(`无法解析 Office 压缩包：${error instanceof Error ? error.message : String(error)}`);
  }
}
function xml(files: Record<string, Uint8Array>, path: string): XmlNode[] {
  if (!files[path]) throw new Error(`Office 文件缺少 ${path}`);
  const text = decode(files[path]);
  if (/<!\s*(DOCTYPE|ENTITY)\b/i.test(text)) throw new Error("不支持含 DTD 或实体声明的 Office XML");
  if (XMLValidator.validate(text) !== true) throw new Error(`Office XML 格式无效：${path}`);
  return parser.parse(text) as XmlNode[];
}
function relationships(files: Record<string, Uint8Array>, source: string): Map<string, { path: string; type: string }> {
  const relPath = posix.join(posix.dirname(source), "_rels", `${posix.basename(source)}.rels`);
  const result = new Map<string, { path: string; type: string }>();
  if (!files[relPath]) return result;
  for (const rel of find(xml(files, relPath), "Relationship")) {
    if (attr(rel, "TargetMode") === "External") continue;
    const target = attr(rel, "Target");
    const path = posix.normalize(target.startsWith("/") ? target.slice(1) : posix.join(posix.dirname(source), target));
    if (path.startsWith("../") || path.includes("\\")) throw new Error("Office 关系路径无效");
    result.set(attr(rel, "Id"), { path, type: attr(rel, "Type") });
  }
  return result;
}
function related(rels: ReturnType<typeof relationships>, id: string): string {
  const rel = rels.get(id);
  if (!rel) throw new Error(`Office 文件缺少内部关系：${id}`);
  return rel.path;
}
function word(nodes: XmlNode[]): string {
  return nodes.map((node) => {
    const name = tag(node).split(":").at(-1);
    if (name === "p") return `${runs(children(node))}\n`;
    if (name === "tr") return `${find(children(node), "tc").map((cell) => word(children(cell)).trimEnd()).join("\t")}\n`;
    return word(children(node));
  }).join("");
}
function excel(files: Record<string, Uint8Array>): string {
  const source = "xl/workbook.xml";
  const rels = relationships(files, source);
  const sharedPath = [...rels.values()].find((rel) => rel.type.endsWith("/sharedStrings"))?.path;
  const shared = sharedPath ? find(xml(files, sharedPath), "si").map((node) => runs(children(node))) : [];
  let text = "";
  for (const sheet of find(xml(files, source), "sheet")) {
    text = checked(`${text}工作表：${attr(sheet, "name")}\n`);
    const root = xml(files, related(rels, attr(sheet, "r:id")));
    for (const cell of find(root, "c")) {
      const address = attr(cell, "r");
      if (!/^[A-Z]+[1-9]\d*$/.test(address)) throw new Error("工作表单元格缺少有效坐标");
      const type = attr(cell, "t");
      let content = value(find(children(cell), "v"));
      if (type === "s") {
        if (!/^\d+$/.test(content) || shared[Number(content)] === undefined) throw new Error("工作表共享字符串索引无效");
        content = shared[Number(content)];
      } else if (type === "inlineStr") content = runs(children(cell));
      else if (type === "b" && content) content = content === "1" ? "TRUE" : "FALSE";
      text = checked(`${text}${address}: ${content}\n`);
    }
    text = checked(`${text}\n`);
  }
  return text.trimEnd();
}
function powerpoint(files: Record<string, Uint8Array>): string {
  const source = "ppt/presentation.xml";
  const rels = relationships(files, source);
  let text = "";
  let index = 0;
  for (const slide of find(xml(files, source), "sldId")) {
    const path = related(rels, attr(slide, "r:id"));
    const content = find(xml(files, path), "p").map((node) => runs(children(node))).join("\n");
    text = checked(`${text}幻灯片 ${++index}\n${content}\n`);
    for (const rel of relationships(files, path).values()) {
      if (rel.type.endsWith("/notesSlide")) {
        const notes = find(xml(files, rel.path), "p").map((node) => runs(children(node))).join("\n");
        text = checked(`${text}备注：\n${notes}\n`);
      }
    }
    text = checked(`${text}\n`);
  }
  return text.trimEnd();
}
async function pdf(bytes: Uint8Array): Promise<string> {
  const { getDocument } = await import("pdfjs-dist/legacy/build/pdf.mjs");
  const packageUrl = import.meta.resolve("pdfjs-dist/package.json");
  const task = getDocument({
    data: Uint8Array.from(bytes),
    useSystemFonts: true,
    cMapUrl: fileURLToPath(new URL("./cmaps/", packageUrl)).replace(/\\/g, "/"),
    cMapPacked: true,
    standardFontDataUrl: fileURLToPath(new URL("./standard_fonts/", packageUrl)).replace(/\\/g, "/"),
  });
  try {
    const document = await task.promise;
    let text = "";
    for (let index = 1; index <= document.numPages; index++) {
      const page = await document.getPage(index);
      try {
        const content = await page.getTextContent();
        for (const item of content.items) {
          if ("str" in item) text = checked(text + item.str + (item.hasEOL ? "\n" : " "));
        }
        text = checked(`${text}\n`);
      } finally {
        page.cleanup();
      }
    }
    if (!text.trim()) throw new Error("PDF 无可提取文本，可能是扫描件；当前不支持 OCR");
    return text.trim();
  } catch (error) {
    if (error instanceof Error && error.name === "PasswordException") throw new Error("PDF 受密码保护，无法提取文本");
    throw error;
  } finally {
    await task.destroy();
  }
}

export async function parseDocument(bytes: Uint8Array, filename: string): Promise<{ text: string; mimeType: string }> {
  const extension = extname(filename).toLowerCase();
  if (/^\.(doc|xls|ppt|zip|rar|7z|gz|tar|mp3|mp4|wav|ogg|flac|aac|m4a|m4v|mov|avi|webm|mkv|wma|wmv|exe|dll|png|jpg|jpeg|gif|webp)$/.test(extension)) {
    throw new Error("不支持此文件类型，请上传文本、PDF、DOCX、XLSX 或 PPTX");
  }
  if (Buffer.from(bytes.subarray(0, 8)).equals(Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]))) {
    throw new Error("不支持旧版二进制 Office 或加密 Office 文件");
  }
  if (extension === ".pdf" || Buffer.from(bytes.subarray(0, 5)).toString("ascii") === "%PDF-") {
    return { text: checked(await pdf(bytes)), mimeType: "application/pdf" };
  }
  if (OFFICE_MIME[extension]) {
    const files = officeFiles(bytes);
    const text = extension === ".docx" ? word(xml(files, "word/document.xml")).trimEnd()
      : extension === ".xlsx" ? excel(files) : powerpoint(files);
    return { text: checked(text), mimeType: OFFICE_MIME[extension] };
  }
  if (bytes[0] === 0x50 && bytes[1] === 0x4b) throw new Error("不支持 ZIP 压缩文件，请上传 DOCX、XLSX 或 PPTX");
  const text = decode(bytes);
  if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/.test(text)) throw new Error("文件包含二进制控制符，无法作为文本解析");
  const mimeType = ({ ".json": "application/json", ".csv": "text/csv", ".md": "text/markdown", ".markdown": "text/markdown" } as Record<string, string>)[extension] ?? "text/plain";
  return { text: checked(text), mimeType };
}
