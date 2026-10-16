import { describe, expect, it } from "vitest";
import { fauxAssistantMessage, fauxText, fauxToolCall, type Context } from "@earendil-works/pi-ai";
import { readTurnCheckpoint } from "agent-core/pi";
import { getTurn, submitMessage } from "../src/worker/turns.ts";
import { parseWebFetch, parseWebSearch } from "../src/shared/protocol.ts";
import { testHost } from "./helpers/host.ts";

const call = (name: string, args: Record<string, unknown>) => fauxAssistantMessage(fauxToolCall(name, args), { stopReason: "toolUse" });
const lastToolText = (ctx: Context) => {
  const result = ctx.messages.findLast(message => message.role === "toolResult");
  return result?.role === "toolResult" && result.content[0].type === "text" ? result.content[0].text : "";
};

// A provider and a page standing in for the network: OpenRouter's search bills $0.004.
function fakeWeb(requests: string[]) {
  return async (input: RequestInfo | URL) => {
    const url = String(input);
    requests.push(url);
    if (url === "https://openrouter.ai/api/v1/chat/completions") return Response.json({ id: "gen-1",
      usage: { cost: 0.004, server_tool_use_details: { web_search_requests: 1 } },
      choices: [{ message: { annotations: [{ type: "url_citation", url_citation: { title: "Lichess analysis", url: "https://lichess.org/analysis", content: "Analysis board" } }] } }] });
    if (url === "https://lichess.org/analysis") return new Response("<html><head><title>Analysis</title></head><body><main><h1>Analysis board</h1><p>Paste a FEN.</p></main></body></html>",
      { headers: { "content-type": "text/html" } });
    return new Response("", { status: 404 });
  };
}

describe("web_search and web_fetch (agent-core's web layer, in the Worker)", () => {
  it("search returns sources, fetch reads one page without a tab, and the search's cost counts in the turn's spend", async () => {
    const host = testHost();
    const requests: string[] = [];
    host.web = { keys: { OPENROUTER_API_KEY: "fixture-key" }, fetch: fakeWeb(requests) as typeof fetch, resolveHostname: async () => ["93.184.216.34"] };
    let tools: string[] = [], searched = "", fetched = "";
    host.respond([
      ctx => { tools = (ctx.tools ?? []).map(tool => tool.name); return call("web_search", { query: "chess analysis board" }); },
      ctx => { searched = lastToolText(ctx); return call("web_fetch", { url: "https://lichess.org/analysis" }); },
      ctx => { fetched = lastToolText(ctx); return fauxAssistantMessage(fauxText("Use the analysis board.")); },
    ]);
    const turn = submitMessage(host, { threadId: "web", text: "find a chess board", context: null, idempotencyKey: "web-key-1" });
    await host.settle();
    expect(getTurn(host, turn.turnId)?.finalAnswer).toBe("Use the analysis board.");
    expect(tools).toEqual(expect.arrayContaining(["web_search", "web_fetch"]));
    expect(searched).toContain("1. Lichess analysis\n   https://lichess.org/analysis");
    expect(fetched).toContain("Title: Analysis");
    expect(fetched).toContain("Paste a FEN.");
    expect(requests).toEqual(["https://openrouter.ai/api/v1/chat/completions", "https://lichess.org/analysis"]);
    expect(readTurnCheckpoint(host.storage, turn.turnId)?.budget.costUsd).toBeCloseTo(0.004, 6);
    expect(JSON.stringify(host.events)).not.toContain("fixture-key");
  });

  it("a failed read or an unconfigured search is a tool error the model reads; nothing private is fetched", async () => {
    const host = testHost();
    const requests: string[] = [];
    host.web = { keys: {}, fetch: fakeWeb(requests) as typeof fetch, resolveHostname: async () => ["10.0.0.1"] };
    const results: string[] = [];
    host.respond([
      () => call("web_search", { query: "anything" }),
      ctx => { results.push(lastToolText(ctx)); return call("web_fetch", { url: "https://internal.example/admin" }); },
      ctx => { results.push(lastToolText(ctx)); return fauxAssistantMessage(fauxText("done")); },
    ]);
    submitMessage(host, { threadId: "web-fail", text: "search", context: null, idempotencyKey: "web-key-2" });
    await host.settle();
    expect(results[0]).toContain("SEARCH_PROVIDER_UNCONFIGURED");
    expect(results[1]).toContain("WEB_FETCH_URL_BLOCKED");
    expect(requests).toEqual([]);
  });

  it("the arguments are checked before anything is sent", () => {
    expect(parseWebSearch({ query: " chess " })).toEqual({ query: "chess", max_results: 5 });
    expect(() => parseWebSearch({ query: "x", url: "https://a.example" })).toThrow("INVALID_ARGS");
    expect(() => parseWebSearch({ query: "x", include_domains: ["not a domain"] })).toThrow("INVALID_ARGS");
    expect(parseWebFetch({ url: "https://a.example/page" })).toEqual({ url: "https://a.example/page" });
    expect(() => parseWebFetch({ url: "https://a.example/page", maxBytes: 10 })).toThrow("INVALID_ARGS");
  });
});
