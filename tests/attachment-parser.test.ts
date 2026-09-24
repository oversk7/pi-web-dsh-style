import assert from "node:assert/strict";
import test from "node:test";
import { zipSync, strToU8 } from "fflate";
import { parseDocument } from "../attachment-parser.ts";

function office(files: Record<string, string>): Uint8Array {
  return zipSync(Object.fromEntries(Object.entries(files).map(([path, text]) => [path, strToU8(text)])));
}
function rels(entries: [string, string, string?][]): string {
  return `<Relationships>${entries.map(([id, target, type = "worksheet"]) => `<Relationship Id="${id}" Target="${target}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/${type}"/>`).join("")}</Relationships>`;
}
function makePdf(content: string, encrypted = false, chinese = false): Uint8Array {
  const literal = chinese ? `<${Buffer.from(content, "utf16le").swap16().toString("hex")}>` : `(${content})`;
  const stream = content ? `BT /F1 12 Tf 50 700 Td ${literal} Tj ET` : "";
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>",
    chinese ? "<< /Type /Font /Subtype /Type0 /BaseFont /STSong-Light /Encoding /UniGB-UCS2-H /DescendantFonts [6 0 R] >>" : "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
    `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`,
  ];
  if (chinese) objects.push(
    "<< /Type /Font /Subtype /CIDFontType0 /BaseFont /STSong-Light /CIDSystemInfo << /Registry (Adobe) /Ordering (GB1) /Supplement 4 >> /FontDescriptor 7 0 R /DW 1000 >>",
    "<< /Type /FontDescriptor /FontName /STSong-Light /Flags 6 /FontBBox [-250 -250 1000 1000] /Ascent 880 /Descent -120 /CapHeight 880 /StemV 80 /ItalicAngle 0 >>",
  );
  if (encrypted) objects.push(`<< /Filter /Standard /V 1 /R 2 /O <${"00".repeat(32)}> /U <${"00".repeat(32)}> /P -4 >>`);
  let result = "%PDF-1.4\n";
  const offsets = [0];
  for (const [index, object] of objects.entries()) {
    offsets.push(result.length);
    result += `${index + 1} 0 obj\n${object}\nendobj\n`;
  }
  const xref = result.length;
  result += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets.slice(1).map((offset) => `${String(offset).padStart(10, "0")} 00000 n \n`).join("")}trailer\n<< /Size ${objects.length + 1} /Root 1 0 R ${encrypted ? `/Encrypt 6 0 R /ID [<${"00".repeat(16)}> <${"00".repeat(16)}>]` : ""} >>\nstartxref\n${xref}\n%%EOF\n`;
  return strToU8(result);
}

test("text accepts UTF-8, unknown text extensions, and BOM UTF-16 in both byte orders", async () => {
  for (const filename of ["note.md", "code.ts", "data.csv", "data.json", "file.unknown"]) {
    assert.equal((await parseDocument(strToU8("你好\n a\t42"), filename)).text, "你好\n a\t42");
  }
  const le = Buffer.from("\ufeff你好\n42", "utf16le");
  const be = Buffer.from(le).swap16();
  for (const bytes of [le, be]) assert.equal((await parseDocument(bytes, "a.txt")).text, "你好\n42");
  assert.equal((await parseDocument(strToU8("\ufeffhello"), "a.txt")).text, "hello");
  assert.equal((await parseDocument(strToU8("{}"), "a.json")).mimeType, "application/json");
});

test("rejects invalid encoding, binary controls, unsupported archives/media and old Office", async () => {
  await assert.rejects(parseDocument(Uint8Array.of(0xc3, 0x28), "bad.txt"), /编码无效/);
  await assert.rejects(parseDocument(Uint8Array.of(0xff, 0xfe, 0x41), "bad.txt"), /编码无效/);
  await assert.rejects(parseDocument(Uint8Array.of(65, 0, 66), "binary.unknown"), /二进制控制符/);
  await assert.rejects(parseDocument(office({ "x.txt": "a" }), "archive.bin"), /ZIP/);
  await assert.rejects(parseDocument(Uint8Array.of(0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1), "old.bin"), /二进制 Office/);
  for (const name of ["a.doc", "a.xls", "a.ppt", "a.zip", "a.mp4", "a.mp3"]) {
    await assert.rejects(parseDocument(strToU8("anything"), name), /不支持/);
  }
});

test("DOCX extracts paragraphs and table cells in document order", async () => {
  const bytes = office({ "word/document.xml": `<w:document><w:body><w:p><w:r><w:t>开始 &amp; </w:t></w:r><w:r><w:t>继续</w:t></w:r></w:p><w:tbl><w:tr><w:tc><w:p><w:r><w:t>左</w:t></w:r></w:p></w:tc><w:tc><w:p><w:r><w:t>右</w:t></w:r></w:p></w:tc></w:tr></w:tbl><w:p><w:r><w:t>结束</w:t></w:r></w:p></w:body></w:document>` });
  const result = await parseDocument(bytes, "report.docx");
  assert.equal(result.text, "开始 & 继续\n左\t右\n结束");
  assert.match(result.mimeType, /wordprocessingml/);
});

test("XLSX follows workbook relationships and preserves cell coordinates and cached values", async () => {
  const bytes = office({
    "xl/workbook.xml": '<workbook><sheets><sheet name="第二页" r:id="two"/><sheet name="第一页" r:id="one"/></sheets></workbook>',
    "xl/_rels/workbook.xml.rels": rels([["one", "worksheets/sheet1.xml"], ["strings", "strings.xml", "sharedStrings"], ["two", "worksheets/sheet2.xml"]]),
    "xl/strings.xml": '<sst><si><r><t>共享</t></r><r><t>字符串</t></r></si></sst>',
    "xl/worksheets/sheet1.xml": '<worksheet><sheetData><row><c r="A1"><v>7</v></c></row></sheetData></worksheet>',
    "xl/worksheets/sheet2.xml": '<worksheet><sheetData><row><c r="A1" t="s"><v>0</v></c><c r="C1" t="inlineStr"><is><t>内联</t></is></c><c r="D1" t="b"><v>1</v></c><c r="E1"><f>1+2</f><v>3</v></c><c r="F1" t="b"><v>0</v></c></row></sheetData></worksheet>',
  });
  assert.equal((await parseDocument(bytes, "book.xlsx")).text, "工作表：第二页\nA1: 共享字符串\nC1: 内联\nD1: TRUE\nE1: 3\nF1: FALSE\n\n工作表：第一页\nA1: 7");
});

test("PPTX follows presentation order and includes only associated notes", async () => {
  const slide = (text: string) => `<p:sld><p:cSld><p:spTree><p:sp><p:txBody><a:p><a:r><a:t>${text}</a:t></a:r></a:p></p:txBody></p:sp></p:spTree></p:cSld></p:sld>`;
  const bytes = office({
    "ppt/presentation.xml": '<p:presentation><p:sldIdLst><p:sldId r:id="two"/><p:sldId r:id="one"/></p:sldIdLst></p:presentation>',
    "ppt/_rels/presentation.xml.rels": rels([["one", "slides/slide1.xml", "slide"], ["two", "slides/slide2.xml", "slide"]]),
    "ppt/slides/slide1.xml": slide("第一页内容"),
    "ppt/slides/slide2.xml": slide("第二页内容"),
    "ppt/slides/_rels/slide2.xml.rels": rels([["notes", "../notesSlides/notesSlide9.xml", "notesSlide"]]),
    "ppt/notesSlides/notesSlide9.xml": slide("相关备注"),
    "ppt/notesSlides/notesSlide1.xml": slide("孤立备注"),
  });
  assert.equal((await parseDocument(bytes, "deck.pptx")).text, "幻灯片 1\n第二页内容\n备注：\n相关备注\n\n幻灯片 2\n第一页内容");
});

test("PDF extracts real text and reports an empty/scanned document", async () => {
  assert.equal((await parseDocument(makePdf("Hello PDF"), "hello.pdf")).text, "Hello PDF");
  await assert.rejects(parseDocument(makePdf(""), "scan.pdf"), /无可提取文本.*扫描件/);
  await assert.rejects(parseDocument(makePdf("Secret", true), "locked.pdf"), /密码保护/);
});

test("PDF decodes Chinese fonts that depend on predefined Adobe CMaps", async () => {
  assert.equal((await parseDocument(makePdf("中文文档", false, true), "中文.pdf")).text, "中文文档");
});

test("rejects oversized output, XML declarations, malformed XML and oversized decompression", async () => {
  assert.equal((await parseDocument(strToU8("x".repeat(200_000)), "a.txt")).text.length, 200_000);
  await assert.rejects(parseDocument(strToU8("x".repeat(200_001)), "a.txt"), /200000/);
  const doc = (text: string) => office({ "word/document.xml": text });
  await assert.rejects(parseDocument(doc('<!DOCTYPE x [<!ENTITY a "boom">]><w:document/>'), "a.docx"), /DTD/);
  await assert.rejects(parseDocument(doc("<w:document><broken></w:document>"), "a.docx"), /XML 格式无效/);
  await assert.rejects(parseDocument(doc(`<w:document><w:p><w:r><w:t>${"x".repeat(200_001)}</w:t></w:r></w:p></w:document>`), "a.docx"), /200000/);
  await assert.rejects(parseDocument(doc("x".repeat(32 * 1024 * 1024 + 1)), "a.docx"), /32MB/);
});
