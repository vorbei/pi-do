// A bounded cache of PDF conversions in the account's Durable Object SQLite, so reading the same
// PDF again (another page, a re-read) neither refetches nor reconverts it. Keyed by the SHA-256
// of the fetched URL, so no URL (a signed one may carry a token) is stored; entries expire after
// PDF_CACHE.ttlMs, and the least recently used go first once PDF_CACHE.maxTotalBytes is passed.
import { PDF_CACHE } from "../config.ts";
import { sha256 } from "agent-core/runtime";
import type { PdfCache } from "./pdf.ts";
import { one, run, type Storage } from "./schema.ts";

export function pdfCache(storage: Storage, now: () => number): PdfCache {
  return {
    async get(url) {
      const key = await sha256(url);
      const row = one<{ markdown: string; created_at: number }>(storage, "SELECT markdown, created_at FROM pdf_cache WHERE key = ?", key);
      if (!row) return null;
      if (row.created_at + PDF_CACHE.ttlMs < now()) {
        run(storage, "DELETE FROM pdf_cache WHERE key = ?", key);
        return null;
      }
      run(storage, "UPDATE pdf_cache SET used_at = ? WHERE key = ?", now(), key);
      return row.markdown;
    },
    async put(url, markdown) {
      const bytes = new TextEncoder().encode(markdown).byteLength;
      if (bytes > PDF_CACHE.maxEntryBytes) return;
      const key = await sha256(url);
      const at = now();
      storage.transactionSync(() => {
        run(storage, "DELETE FROM pdf_cache WHERE created_at < ?", at - PDF_CACHE.ttlMs);
        run(storage, `INSERT INTO pdf_cache (key, markdown, bytes, created_at, used_at) VALUES (?, ?, ?, ?, ?)
          ON CONFLICT (key) DO UPDATE SET markdown = excluded.markdown, bytes = excluded.bytes, created_at = excluded.created_at, used_at = excluded.used_at`,
        key, markdown, bytes, at, at);
        for (;;) {
          const total = one<{ n: number }>(storage, "SELECT COALESCE(SUM(bytes), 0) AS n FROM pdf_cache")?.n ?? 0;
          if (total <= PDF_CACHE.maxTotalBytes) break;
          run(storage, "DELETE FROM pdf_cache WHERE key = (SELECT key FROM pdf_cache ORDER BY used_at, created_at LIMIT 1)");
        }
      });
    },
  };
}
