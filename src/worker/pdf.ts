// The Worker's PDF read for the extension (`POST /api/pdf/text`): agent-core's server-side PDF read
// (fetched by its public URL without cookies, converted by Workers AI `toMarkdown`, `--- page N ---`
// lines from the page `#page=N` names) with pi-do's limits, its deployment's converter and the
// account's cache, answered in the extension protocol's shape.
import { PdfReadError, publicPdfUrl, readPdf, type MarkdownConversion, type PdfCache, type ToMarkdown } from "agent-core/runtime";
import { PDF_READ } from "../config.ts";
import type { PdfTextRequest, PdfTextResponse } from "../shared/protocol.ts";

export type { PdfCache };
export type ConversionResult = MarkdownConversion;
export interface MarkdownDocument { name: string; blob: Blob; }
export interface PdfEnv { AI?: { toMarkdown: ToMarkdown }; PDF_TEST_CONVERTER_URL?: string; }

export interface PdfDeps {
  fetch: (url: string, init: RequestInit) => Promise<Response>;
  /** null: this Worker has no Workers AI binding. */
  toMarkdown: ToMarkdown | null;
  /** Local smoke only: PDF URLs on a loopback host are allowed. */
  allowLoopback: boolean;
  /** Earlier conversions; only a successful conversion of a public URL is stored. */
  cache?: PdfCache;
}

export function pdfDeps(env: PdfEnv): PdfDeps {
  const fetchFn = (url: string, init: RequestInit) => fetch(url, init);
  if (env.AI) return { fetch: fetchFn, toMarkdown: files => env.AI!.toMarkdown(files), allowLoopback: false };
  // wrangler dev has no local Workers AI; the Chrome smoke supplies a fake converter here.
  // Remove when wrangler dev can run toMarkdown offline (the smoke's PDF scenario then needs no var).
  const converter = env.PDF_TEST_CONVERTER_URL;
  if (converter) {
    return { fetch: fetchFn, allowLoopback: true,
      toMarkdown: async ([file]) => (await fetch(converter, { method: "POST", body: file.blob })).json() };
  }
  return { fetch: fetchFn, toMarkdown: null, allowLoopback: false };
}

export async function pdfText(request: PdfTextRequest, deps: PdfDeps): Promise<PdfTextResponse> {
  try {
    const read = await readPdf(request.url, { fetch: deps.fetch, toMarkdown: deps.toMarkdown, cache: deps.cache, limits: PDF_READ,
      maxChars: request.maxChars, validateUrl: url => publicPdfUrl(url, { allowLoopback: deps.allowLoopback }) });
    return { ok: true, pages: read.pages, from: read.from, text: read.text };
  } catch (error) {
    if (error instanceof PdfReadError) return { ok: false, stage: error.stage, reason: error.message };
    throw error;
  }
}
