/** Disposable, synthetic material for manual sandbox acceptance. No author files read. */
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { Document, Packer, Paragraph } from "docx";
import PptxGenJS from "pptxgenjs";
import JSZip from "jszip";

if (process.argv[2] === "--verify") {
  const manifest = JSON.parse(readFileSync(process.argv[3], "utf8"));
  for (const { path, sha256 } of manifest.sources) {
    if (createHash("sha256").update(readFileSync(path)).digest("hex") !== sha256) throw new Error(`Source changed: ${path}`);
  }
  console.log("All import sources are unchanged.");
} else {
  if (process.argv.length !== 2) throw new Error("Usage: node scripts/create-appstore-fixtures.mjs [--verify manifest.json]");
  const root = mkdtempSync(join(tmpdir(), "ai-writer-store-"));
  const sources = join(root, "导入 sources");
  const project = join(root, "项目 中文 空格");
  mkdirSync(sources); mkdirSync(project);
  const manifest = { root, project, sources: [] };
  const save = (name, data) => {
    const path = join(sources, name); writeFileSync(path, data);
    manifest.sources.push({ path, sha256: createHash("sha256").update(readFileSync(path)).digest("hex") });
  };
  save("sample.md", "# Sandbox acceptance\n\n中文、空格路径与离线编辑。\n\n![pixel](pixel.png)\n");
  save("sample.txt", "Import preserves its source.\n");
  save("pixel.png", Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aD1sAAAAASUVORK5CYII=", "base64"));
  save("sample.html", '<!doctype html><meta charset="utf-8"><h1>Local preview</h1><p>中文排版与打印</p><img src="pixel.png"><script>document.body.dataset.scriptRan="yes"</script>');
  save("sample.docx", await Packer.toBuffer(new Document({ sections: [{ children: [new Paragraph("Sandbox import — 中文文本")] }] })));
  const deck = new PptxGenJS(); deck.addSlide().addText("Sandbox import — 中文文本", { x: 1, y: 1, w: 7, h: 1 });
  save("sample.pptx", await deck.write({ outputType: "nodebuffer" }));
  const zip = new JSZip();
  zip.file("[Content_Types].xml", '<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/></Types>');
  zip.file("_rels/.rels", '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>');
  zip.file("xl/workbook.xml", '<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="Sheet 1" sheetId="1" r:id="rId1"/></sheets></workbook>');
  zip.file("xl/_rels/workbook.xml.rels", '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/></Relationships>');
  zip.file("xl/worksheets/sheet1.xml", '<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData><row r="1"><c r="A1" t="inlineStr"><is><t>Keep 00123 as text</t></is></c><c r="B1"><v>42</v></c></row></sheetData></worksheet>');
  save("sample.xlsx", await zip.generateAsync({ type: "nodebuffer" }));
  // Minimal uncompressed one-page PDF, with byte-correct xref offsets.
  const stream = "BT /F1 18 Tf 40 100 Td (Sandbox PDF import) Tj ET";
  const objects = ['<< /Type /Catalog /Pages 2 0 R >>', '<< /Type /Pages /Kids [3 0 R] /Count 1 >>', '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 200] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>', '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>', `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`];
  let pdf = "%PDF-1.4\n"; const offsets = [0];
  objects.forEach((object, i) => { offsets.push(Buffer.byteLength(pdf)); pdf += `${i + 1} 0 obj\n${object}\nendobj\n`; });
  const xref = Buffer.byteLength(pdf);
  pdf += `xref\n0 ${offsets.length}\n0000000000 65535 f \n` + offsets.slice(1).map(n => `${String(n).padStart(10, "0")} 00000 n \n`).join("");
  pdf += `trailer\n<< /Size ${offsets.length} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  save("sample.pdf", pdf);
  save("sample.wav", readFileSync(new URL("../src/lib/asr/__tests__/fixtures/hello-world.wav", import.meta.url)));
  const manifestPath = join(root, "manifest.json"); writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));
  console.log(JSON.stringify({ root, project, sources, manifest: manifestPath }, null, 2));
}
