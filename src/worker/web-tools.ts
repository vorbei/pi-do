// The model's web_search and web_fetch tools: agent-core's web layer (shared with X Gardener) run in
// the Worker, without a tab. A search's provider cost is added to the turn's spend; both are reads,
// counted against the turn's tool calls like every call.
import { Type } from "@earendil-works/pi-ai";
import { fetchWebEvidence, searchWeb, type SearchEvidence, type WebEvidence } from "agent-core/web";
import { parseWebFetch, parseWebSearch, ProtocolError, WEB_FETCH_TOOL, WEB_SEARCH_TOOL, WEB_TEXT_MAX_CHARS } from "../shared/protocol.ts";
import type { PiTool } from "./memory-tools.ts";
import { WEB_FETCH_TOOL_DESCRIPTION, WEB_SEARCH_TOOL_DESCRIPTION } from "./prompt.ts";

/** What the web tools need from the host: the search providers' keys and, in tests, a fetch and DNS stand-in. */
export interface WebHost {
  keys: { OPENROUTER_API_KEY?: string; TAVILY_API_KEY?: string; BRAVE_API_KEY?: string };
  fetch?: typeof fetch;
  resolveHostname?: (hostname: string) => Promise<string[]>;
}

const text = (value: string) => ({ content: [{ type: "text" as const, text: value }], details: {} });

/**
 * web_search and web_fetch for one turn. `addCost` adds a billed search's USD cost to the turn's
 * spend (agent-core's turn budget); `log` gets the network events (no keys, queries or bodies).
 */
export function webTools(web: WebHost, addCost: (usd: number | undefined) => void, log: (event: string, detail: Record<string, unknown>) => void): PiTool[] {
  const search: PiTool = {
    name: WEB_SEARCH_TOOL, label: "Web search", description: WEB_SEARCH_TOOL_DESCRIPTION, executionMode: "sequential",
    parameters: Type.Object({
      query: Type.String({ minLength: 1, maxLength: 500 }),
      max_results: Type.Optional(Type.Integer({ minimum: 1, maximum: 10 })),
      include_domains: Type.Optional(Type.Array(Type.String(), { maxItems: 10, description: "only results from these domains (example.com)" })),
    }),
    async execute(_toolCallId, params) {
      const input = parsed(() => parseWebSearch(params), WEB_SEARCH_TOOL);
      let result: SearchEvidence;
      try {
        result = await searchWeb(input, web.keys, { fetchImpl: web.fetch, onEvent: (event, detail) => log(event, detail) });
      } catch (error) {
        for (const usage of (error as { providerUsage?: SearchEvidence["providerUsage"] }).providerUsage ?? []) addCost(usage.costUsd ?? undefined);
        throw new Error(`${(error as { code?: string }).code ?? "SEARCH_PROVIDERS_FAILED"}: ${(error as Error).message}`);
      }
      for (const usage of result.providerUsage) addCost(usage.costUsd ?? undefined);
      return text(searchText(result));
    },
  };
  const read: PiTool = {
    name: WEB_FETCH_TOOL, label: "Web fetch", description: WEB_FETCH_TOOL_DESCRIPTION, executionMode: "sequential",
    parameters: Type.Object({
      url: Type.String({ minLength: 8, maxLength: 2048 }),
      maxBytes: Type.Optional(Type.Integer({ minimum: 1024, maximum: 262_144, description: "raw bytes of HTML to read; omit normally" })),
    }),
    async execute(_toolCallId, params) {
      const input = parsed(() => parseWebFetch(params), WEB_FETCH_TOOL);
      let evidence: WebEvidence;
      try {
        evidence = await fetchWebEvidence(input, { ...(web.fetch ? { fetchImpl: web.fetch } : {}), ...(web.resolveHostname ? { resolveHostname: web.resolveHostname } : {}) });
      } catch (error) {
        throw new Error(`${(error as { code?: string }).code ?? "WEB_FETCH_FAILED"}: ${(error as Error).message}`);
      }
      return text(fetchText(evidence));
    },
  };
  return [search, read];
}

function parsed<T>(parse: () => T, tool: string): T {
  try { return parse(); }
  catch (error) { throw new Error(`Invalid ${tool} call: ${error instanceof ProtocolError ? error.message : String((error as Error).message)}`); }
}

/** What the model reads of a search: one numbered source per result, its snippet and date when known. */
export function searchText(result: SearchEvidence): string {
  const lines = result.items.map((item, index) => `${index + 1}. ${item.title}\n   ${item.url}${item.publishedDate ? ` (published ${item.publishedDate})` : ""}\n   ${item.snippet.replace(/\s+/g, " ")}`);
  return `Search results for "${result.query}" (${result.provider}; untrusted snippets, not full pages):\n${lines.join("\n")}`;
}

/** What the model reads of a page: its address, title and readable text, cut at WEB_TEXT_MAX_CHARS. */
export function fetchText(evidence: WebEvidence): string {
  const cut = evidence.text.length > WEB_TEXT_MAX_CHARS;
  return [`${evidence.finalUrl} (HTTP ${evidence.status}, ${evidence.contentKind}; untrusted page content)`,
    ...(evidence.title ? [`Title: ${evidence.title}`] : []),
    ...(evidence.publishedAt ? [`Published: ${evidence.publishedAt}`] : []),
    "", evidence.text.slice(0, WEB_TEXT_MAX_CHARS),
    ...(cut || evidence.truncated ? [`[cut: ${cut ? `the text continues past ${WEB_TEXT_MAX_CHARS} characters` : "the page continues past the bytes read"}]`] : [])].join("\n");
}
