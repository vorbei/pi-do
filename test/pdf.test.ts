import { describe, expect, it } from "vitest";
import { PDF_CACHE, PDF_READ } from "../src/config.ts";
import { pdfCache } from "../src/worker/pdf-cache.ts";
import { migrate, rows } from "../src/worker/schema.ts";
import { sqliteStorage } from "./helpers/host.ts";
import { parsePdfTextRequest } from "../src/shared/protocol.ts";
import { pdfDeps, pdfText, type ConversionResult, type MarkdownDocument, type PdfDeps } from "../src/worker/pdf.ts";
import { makePdf } from "./fixtures/pdf.ts";

// What Workers AI toMarkdown returns for a PDF: a title, a metadata list, then one "### Page N" per page.
const CONVERTED = "# document.pdf\n## Metadata\n- PDFFormatVersion=1.4\n- Title=Paper\n\n## Contents\n### Page 1\nAlpha opening\n### Page 2\nBeta method\n### Page 3\nGamma results";

/** A Worker with a fake network (`routes` by URL) and a fake Workers AI binding; both record their calls. */
function worker(routes: Record<string, () => Response>, convert: (files: MarkdownDocument[]) => ConversionResult[] | Promise<ConversionResult[]> = () => [{ format: "markdown", data: CONVERTED }]) {
  const fetched: { url: string; init: RequestInit }[] = [];
  const converted: MarkdownDocument[] = [];
  const deps: PdfDeps = {
    allowLoopback: false,
    fetch: async (url, init) => {
      fetched.push({ url, init });
      const route = routes[url];
      if (!route) throw new TypeError("fetch failed");
      return route();
    },
    toMarkdown: async files => { converted.push(...files); return convert(files); },
  };
  return { deps, fetched, converted };
}

const pdfResponse = (headers: Record<string, string> = {}) => () => new Response(makePdf(["Alpha opening", "Beta method", "Gamma results"]) as Uint8Array<ArrayBuffer>, { headers: { "Content-Type": "application/pdf", ...headers } });
const read = (url: string, deps: PdfDeps, maxChars = 20_000) => pdfText(parsePdfTextRequest({ url, maxChars }), deps);

describe("Worker PDF read", () => {
  it("converts a public PDF with Workers AI into --- page N --- sections from the URL's #page=N", async () => {
    const w = worker({ "https://papers.example/a.pdf": pdfResponse() });
    expect(await read("https://papers.example/a.pdf", w.deps)).toEqual({ ok: true, pages: 3, from: 1,
      text: "--- page 1 ---\nAlpha opening\n\n--- page 2 ---\nBeta method\n\n--- page 3 ---\nGamma results" });
    expect(await read("https://papers.example/a.pdf#page=2", w.deps)).toEqual({ ok: true, pages: 3, from: 2,
      text: "--- page 2 ---\nBeta method\n\n--- page 3 ---\nGamma results" });
    expect(await read("https://papers.example/a.pdf#page=9", w.deps)).toEqual({ ok: true, pages: 3, from: 9, text: "" });
    // The fragment is not sent, redirects are followed by hand, and no cookie or credential goes out.
    expect(w.fetched[0].url).toBe("https://papers.example/a.pdf");
    expect(w.fetched[0].init.redirect).toBe("manual");
    expect(JSON.stringify(w.fetched[0].init.headers)).not.toMatch(/cookie|authorization/i);
    expect(w.converted[0].blob.type).toBe("application/pdf");
  });

  it("stops after the page that passes maxChars", async () => {
    const long = "w".repeat(150);
    const w = worker({ "https://papers.example/a.pdf": pdfResponse() },
      () => [{ format: "markdown", data: `## Contents\n### Page 1\n${long}\n### Page 2\n${long}\n### Page 3\n${long}` }]);
    const result = await read("https://papers.example/a.pdf", w.deps, 100);
    expect(result).toMatchObject({ ok: true, pages: 3 });
    expect(result.ok && result.text).toBe(`--- page 1 ---\n${long}`);
  });

  it("returns one unsplit block when the conversion reports no page boundaries", async () => {
    const w = worker({ "https://papers.example/a.pdf": pdfResponse() }, () => [{ format: "markdown", data: "Just text" }]);
    expect(await read("https://papers.example/a.pdf#page=2", w.deps)).toEqual({ ok: true, pages: null, from: 2, text: "Just text" });
  });

  it("reports a PDF it cannot fetch, with the reason, and converts nothing", async () => {
    const w = worker({
      "https://papers.example/login.pdf": () => new Response("no", { status: 403 }),
      "https://papers.example/gone.pdf": () => new Response("no", { status: 404 }),
      "https://papers.example/portal.pdf": () => new Response("<html>Sign in</html>", { headers: { "Content-Type": "text/html" } }),
    });
    expect(await read("https://papers.example/login.pdf", w.deps)).toMatchObject({ ok: false, stage: "fetch", reason: expect.stringMatching(/HTTP 403.*login.*without your cookies/) });
    expect(await read("https://papers.example/gone.pdf", w.deps)).toMatchObject({ ok: false, stage: "fetch", reason: "HTTP 404" });
    expect(await read("https://papers.example/portal.pdf", w.deps)).toMatchObject({ ok: false, stage: "fetch", reason: expect.stringMatching(/did not return a PDF/) });
    expect(await read("https://unreachable.example/a.pdf", w.deps)).toMatchObject({ ok: false, stage: "fetch", reason: expect.stringMatching(/could not be reached/) });
    expect(w.converted).toEqual([]);
  });

  it("refuses a PDF over the size cap, by its declared length or while reading it", async () => {
    const chunk = new Uint8Array(1024 * 1024);
    let sent = 0;
    const endless = () => new Response(new ReadableStream({ pull(controller) { sent++; controller.enqueue(chunk); } }));
    const w = worker({
      "https://papers.example/declared.pdf": pdfResponse({ "Content-Length": String(PDF_READ.maxBytes + 1) }),
      "https://papers.example/streamed.pdf": endless,
    });
    expect(await read("https://papers.example/declared.pdf", w.deps)).toMatchObject({ ok: false, stage: "fetch", reason: expect.stringMatching(/larger than 30 MiB/) });
    expect(await read("https://papers.example/streamed.pdf", w.deps)).toMatchObject({ ok: false, stage: "fetch", reason: expect.stringMatching(/larger than 30 MiB/) });
    expect(sent).toBeLessThanOrEqual(PDF_READ.maxBytes / chunk.byteLength + 2);
    expect(w.converted).toEqual([]);
  });

  it("reads only public http(s) URLs, the redirect targets included", async () => {
    expect(() => parsePdfTextRequest({ url: "file:///Users/me/a.pdf", maxChars: 1_000 })).toThrow(/INVALID_ARGS/);
    expect(() => parsePdfTextRequest({ url: "chrome-extension://abc/a.pdf", maxChars: 1_000 })).toThrow(/INVALID_ARGS/);
    const redirect = (location: string) => () => new Response(null, { status: 302, headers: { Location: location } });
    const w = worker({
      "https://papers.example/to-ftp.pdf": redirect("ftp://files.example/a.pdf"),
      "https://papers.example/to-intranet.pdf": redirect("http://10.0.0.8/a.pdf"),
      "https://papers.example/moved.pdf": redirect("/real.pdf"),
      "https://papers.example/real.pdf": pdfResponse(),
    });
    expect(await read("https://papers.example/to-ftp.pdf", w.deps)).toMatchObject({ ok: false, stage: "fetch", reason: expect.stringMatching(/only http\(s\)/) });
    expect(await read("https://papers.example/to-intranet.pdf", w.deps)).toMatchObject({ ok: false, stage: "fetch", reason: expect.stringMatching(/public hosts/) });
    for (const host of ["127.0.0.1", "localhost", "192.168.1.2", "[::1]", "printer.local"]) {
      expect(await read(`http://${host}/a.pdf`, w.deps)).toMatchObject({ ok: false, stage: "fetch", reason: expect.stringMatching(/public hosts/) });
    }
    expect(await read("https://papers.example/moved.pdf", w.deps)).toMatchObject({ ok: true, pages: 3 });
    expect(w.fetched.map(item => item.url)).toEqual(["https://papers.example/to-ftp.pdf", "https://papers.example/to-intranet.pdf",
      "https://papers.example/moved.pdf", "https://papers.example/real.pdf"]);
  });

  it("reports a conversion failure, an empty conversion and a missing binding as convert failures", async () => {
    const routes = { "https://papers.example/a.pdf": pdfResponse() };
    expect(await read("https://papers.example/a.pdf", worker(routes, () => { throw new Error("internal error"); }).deps))
      .toMatchObject({ ok: false, stage: "convert", reason: expect.stringMatching(/conversion failed: internal error/) });
    expect(await read("https://papers.example/a.pdf", worker(routes, () => [{ format: "error", error: "unsupported" }]).deps))
      .toMatchObject({ ok: false, stage: "convert", reason: expect.stringMatching(/unsupported/) });
    expect(await read("https://papers.example/a.pdf", worker(routes, () => [{ format: "markdown", data: "  " }]).deps))
      .toMatchObject({ ok: false, stage: "convert", reason: expect.stringMatching(/no text/) });
    expect(await read("https://papers.example/a.pdf", { ...worker(routes).deps, toMarkdown: null }))
      .toMatchObject({ ok: false, stage: "convert", reason: expect.stringMatching(/no Workers AI binding/) });
  });

  it("uses the Workers AI binding when bound, and allows loopback PDFs only with the smoke's test converter", () => {
    const ai = { toMarkdown: async () => [] };
    expect(pdfDeps({ AI: ai })).toMatchObject({ allowLoopback: false, toMarkdown: expect.any(Function) });
    expect(pdfDeps({ AI: ai, PDF_TEST_CONVERTER_URL: "http://127.0.0.1:1/convert" }).allowLoopback).toBe(false);
    expect(pdfDeps({ PDF_TEST_CONVERTER_URL: "http://127.0.0.1:1/convert" })).toMatchObject({ allowLoopback: true, toMarkdown: expect.any(Function) });
    expect(pdfDeps({})).toMatchObject({ allowLoopback: false, toMarkdown: null });
  });
});

describe("PDF conversion cache", () => {
  const cached = () => {
    const storage = sqliteStorage();
    migrate(storage);
    const clock = { now: 1_000_000 };
    return { storage, clock, cache: pdfCache(storage, () => clock.now) };
  };

  it("reads the same PDF again, any page, without refetching or reconverting, and stores no URL", async () => {
    const { storage, cache } = cached();
    const w = worker({ "https://papers.example/a.pdf?token=secret": pdfResponse() });
    const deps = { ...w.deps, cache };
    await read("https://papers.example/a.pdf?token=secret#page=1", deps);
    expect(await read("https://papers.example/a.pdf?token=secret#page=3", deps)).toEqual({ ok: true, pages: 3, from: 3, text: "--- page 3 ---\nGamma results" });
    expect(w.fetched).toHaveLength(1);
    expect(w.converted).toHaveLength(1);
    expect(JSON.stringify(rows(storage, "SELECT * FROM pdf_cache"))).not.toMatch(/papers\.example|secret/);
  });

  it("expires entries, skips oversized ones, caches no failure, and drops the least recently used past the total", async () => {
    const { storage, clock, cache } = cached();
    const w = worker({ "https://papers.example/a.pdf": pdfResponse() });
    await read("https://papers.example/a.pdf", { ...w.deps, cache });
    clock.now += PDF_CACHE.ttlMs + 1;
    await read("https://papers.example/a.pdf", { ...w.deps, cache });
    expect(w.fetched).toHaveLength(2);

    await cache.put("https://big.example/x.pdf", "x".repeat(PDF_CACHE.maxEntryBytes + 1));
    expect(await cache.get("https://big.example/x.pdf")).toBeNull();

    const failing = worker({ "https://papers.example/b.pdf": () => new Response("denied", { status: 403 }) });
    await read("https://papers.example/b.pdf", { ...failing.deps, cache });
    await read("https://papers.example/b.pdf", { ...failing.deps, cache });
    expect(failing.fetched).toHaveLength(2);

    const chunk = "y".repeat(PDF_CACHE.maxEntryBytes);
    const count = Math.ceil(PDF_CACHE.maxTotalBytes / PDF_CACHE.maxEntryBytes) + 1;
    for (let index = 0; index < count; index++) { clock.now += 1; await cache.put(`https://p.example/${index}.pdf`, chunk); }
    expect(await cache.get("https://p.example/0.pdf")).toBeNull();
    expect(await cache.get(`https://p.example/${count - 1}.pdf`)).toBe(chunk);
    expect(rows<{ n: number }>(storage, "SELECT SUM(bytes) AS n FROM pdf_cache")[0].n).toBeLessThanOrEqual(PDF_CACHE.maxTotalBytes);
  });
});
