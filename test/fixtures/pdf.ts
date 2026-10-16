// Builds a small, valid PDF with one line of Helvetica text per page (unit tests and the smoke).
export function makePdf(pages: string[]): Uint8Array {
  const escape = (text: string) => text.replace(/[\\()]/g, match => `\\${match}`);
  const objects: string[] = [];
  const pageIds = pages.map((_, index) => 4 + index * 2);
  objects[1] = "<</Type/Catalog/Pages 2 0 R>>";
  objects[2] = `<</Type/Pages/Kids[${pageIds.map(id => `${id} 0 R`).join(" ")}]/Count ${pages.length}>>`;
  objects[3] = "<</Type/Font/Subtype/Type1/BaseFont/Helvetica>>";
  pages.forEach((text, index) => {
    const stream = `BT /F1 18 Tf 40 700 Td (${escape(text)}) Tj ET`;
    objects[pageIds[index]] = `<</Type/Page/Parent 2 0 R/MediaBox[0 0 612 792]/Resources<</Font<</F1 3 0 R>>>>/Contents ${pageIds[index] + 1} 0 R>>`;
    objects[pageIds[index] + 1] = `<</Length ${stream.length}>>stream\n${stream}\nendstream`;
  });
  let body = "%PDF-1.4\n";
  const offsets: number[] = [];
  for (let id = 1; id < objects.length; id++) {
    offsets[id] = body.length;
    body += `${id} 0 obj\n${objects[id]}\nendobj\n`;
  }
  const xref = body.length;
  body += `xref\n0 ${objects.length}\n0000000000 65535 f \n`;
  for (let id = 1; id < objects.length; id++) body += `${String(offsets[id]).padStart(10, "0")} 00000 n \n`;
  body += `trailer\n<</Size ${objects.length}/Root 1 0 R>>\nstartxref\n${xref}\n%%EOF\n`;
  return new TextEncoder().encode(body);
}
