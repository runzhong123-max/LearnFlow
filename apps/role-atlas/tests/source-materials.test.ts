import assert from "node:assert/strict";
import test from "node:test";
import { zipSync, strToU8 } from "fflate";
import { materialSource, parseMaterialFile, MAX_MATERIAL_BYTES } from "@/lib/source-materials";
import { isPublicV4, validateMaterialUrl } from "@/lib/source-url";

test("附件保留文件名、类型与完整文本", async () => {
  const source = await parseMaterialFile(new File(["网络运维\n故障定位与回滚"], "岗位.md"), "private_document");
  assert.equal(source.title, "岗位.md"); assert.equal(source.locator, "attachment:岗位.md");
  assert.equal(source.content, "网络运维\n故障定位与回滚"); assert.equal(source.kind, "private_document");
});
test("DOCX 提取表格文字和段落，忽略无关 ZIP 文件", async () => {
  const data = zipSync({ "word/document.xml": strToU8('<w:document><w:p><w:r><w:t>部署 &amp; 验收</w:t></w:r></w:p><w:p><w:r><w:t>失败回滚</w:t></w:r></w:p></w:document>'), "ignored.txt": strToU8("ignored") });
  const source = await parseMaterialFile(new File([Uint8Array.from(data)], "岗位.docx"), "public_document");
  assert.equal(source.content, "部署 & 验收\n失败回滚");
});
test("空资料、超长、二进制和不支持附件明确失败而不截断", async () => {
  assert.throws(() => materialSource("x", " ", "public_document"), /OCR/);
  assert.throws(() => materialSource("x", "a".repeat(60_001), "public_document"), /拆分/);
  await assert.rejects(parseMaterialFile(new File(["binary"], "x.exe"), "public_document"), /支持/);
  await assert.rejects(parseMaterialFile(new File(["\0"], "x.txt"), "public_document"), /二进制/);
  await assert.rejects(parseMaterialFile(new File([new Uint8Array(MAX_MATERIAL_BYTES + 1)], "x.txt"), "public_document"), /5 MB/);
});
test("URL 阻止本机、内网、凭据、非 HTTPS 和非标准端口", () => {
  for (const url of ["http://example.com", "https://localhost", "https://127.1", "https://10.0.0.1", "https://user:pass@example.com", "https://example.com:8443", "https://169.254.169.254"]) assert.throws(() => validateMaterialUrl(url));
  for (const ip of ["127.0.0.1", "172.16.0.1", "100.64.0.1", "192.168.1.1", "::1", "169.254.169.254"]) assert.equal(isPublicV4(ip), false);
  assert.equal(validateMaterialUrl("https://docs.bigmodel.cn/").hostname, "docs.bigmodel.cn");
  assert.equal(isPublicV4("1.1.1.1"), true);
});


test("PDF 附件提取文字并释放解析资源", async () => {
  const stream = "BT /F1 12 Tf 50 100 Td (Network operations and rollback) Tj ET";
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 200] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>",
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
    `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`,
  ];
  let pdf = "%PDF-1.4\n"; const offsets = [0];
  objects.forEach((object, index) => { offsets.push(pdf.length); pdf += `${index + 1} 0 obj\n${object}\nendobj\n`; });
  const start = pdf.length;
  pdf += `xref\n0 6\n0000000000 65535 f \n${offsets.slice(1).map((offset) => `${String(offset).padStart(10, "0")} 00000 n `).join("\n")}\ntrailer\n<< /Root 1 0 R /Size 6 >>\nstartxref\n${start}\n%%EOF`;
  const source = await parseMaterialFile(new File([pdf], "operations.pdf"), "public_document");
  assert.match(source.content, /Network operations and rollback/);
});
