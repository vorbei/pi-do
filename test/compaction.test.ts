import { describe, expect, it } from "vitest";
import { fauxAssistantMessage, fauxText, fauxToolCall, type Context } from "@earendil-works/pi-ai";
import { claimBrowserCall, completeBrowserCall, getTurn, submitMessage } from "../src/worker/turns.ts";
import { COMPACTION_SYSTEM_PROMPT } from "../src/worker/prompt.ts";
import { checkpointMessages, readTurnCheckpoint } from "agent-core/pi";
import { rows } from "../src/worker/schema.ts";
import { testHost } from "./helpers/host.ts";

let keys = 0;
const text = (ctx: Context) => ctx.messages.map(message => typeof message.content === "string" ? message.content
  : message.content.map(part => part.type === "text" ? part.text : "").join("")).join("\n");
// Pi's native compaction (agent-core's attempt) keeps the summary in the thread's journal: the turn's history starts with it.
const history = (host: ReturnType<typeof testHost>, turnId: string) => checkpointMessages(readTurnCheckpoint(host.storage, turnId)!);
// Pi measures the context as the model reported it (system prompt and tools included): the thread's size after a turn.
const contextTokens = (host: ReturnType<typeof testHost>, turnId: string) =>
  (history(host, turnId).findLast((message: { role: string }) => message.role === "assistant") as { usage: { totalTokens: number } }).usage.totalTokens;
const LARGE = { compactAtTokens: 100_000, keepRecentTokens: 100 };

describe("thread compaction", () => {
  it("summarizes older history once past the threshold, stores the summary, and builds on it next time", async () => {
    const host = testHost();
    host.compaction = LARGE;
    const send = (words: string) => submitMessage(host, { threadId: "long", text: words, context: null, idempotencyKey: `compaction-${++keys}` });
    host.respond([fauxAssistantMessage(fauxText(`Alpha findings ${"a".repeat(1_200)}`))]);
    send("first question");
    await host.settle();
    host.respond([fauxAssistantMessage(fauxText(`Beta findings ${"b".repeat(1_200)}`))]);
    const second = send("second question");
    await host.settle();

    // The thread is now past the threshold: the third turn's first request waits for the summary.
    host.compaction = { compactAtTokens: contextTokens(host, second.turnId) - 50, keepRecentTokens: 100 };
    let summarized = "";
    let seen = "";
    host.respond([
      ctx => { summarized = text(ctx); return fauxAssistantMessage(fauxText("The user asked two questions; alpha and beta were found.")); },
      ctx => { seen = text(ctx); return fauxAssistantMessage(fauxText("done")); },
    ]);
    const third = send("third question");
    await host.settle();
    expect(getTurn(host, third.turnId)?.finalAnswer).toBe("done");
    expect(rows(host.storage, "SELECT status, error_code FROM agent_turns")).toEqual([{ status: "completed", error_code: null }, { status: "completed", error_code: null }, { status: "completed", error_code: null }]);
    // The summarizer got the old history; the model then saw the summary instead of it.
    expect(summarized).toContain("Alpha findings");
    expect(seen).toContain("The user asked two questions; alpha and beta were found.");
    expect(seen).not.toContain("Alpha findings");
    expect(seen).toContain("third question");
    expect(history(host, third.turnId)[0]).toMatchObject({ role: "compactionSummary", summary: "The user asked two questions; alpha and beta were found." });

    // The next turn starts from the stored summary without another summary request while small.
    host.compaction = LARGE;
    host.respond([ctx => { seen = text(ctx); return fauxAssistantMessage(fauxText("ok")); }]);
    const before = host.requests;
    send("fourth question");
    await host.settle();
    expect(host.requests - before).toBe(1);
    expect(seen).toContain("The user asked two questions; alpha and beta were found.");
    expect(seen).not.toContain("Alpha findings");
  });

  it("abandons a summary after summaryTimeoutMs, and does not ask again on the same turn's resumes; the next turn may", async () => {
    const host = testHost();
    host.compaction = LARGE;
    const send = (words: string) => submitMessage(host, { threadId: "slow", text: words, context: null, idempotencyKey: `compaction-${++keys}` });
    host.respond([fauxAssistantMessage(fauxText(`Alpha ${"a".repeat(1_200)}`)), fauxAssistantMessage(fauxText(`Beta ${"b".repeat(1_200)}`))]);
    send("first question");
    await host.settle();
    const second = send("second question");
    await host.settle();
    // The third turn starts past the threshold: its first request waits for a summary.
    host.compaction = { compactAtTokens: contextTokens(host, second.turnId) - 50, keepRecentTokens: 100, summaryTimeoutMs: 30 };

    // From here on the summarizer never answers; the turn's own requests do.
    let summaries = 0;
    const base = host.streamFn;
    host.streamFn = (model, ctx, options) => {
      if (ctx.systemPrompt !== COMPACTION_SYSTEM_PROMPT) return base(model, ctx, options);
      summaries++;
      return { result: () => new Promise(() => {}) } as never;
    };
    host.respond([
      fauxAssistantMessage(fauxToolCall("browser", { action: "tabs" }), { stopReason: "toolUse" }),
      fauxAssistantMessage(fauxText("third done")),
      fauxAssistantMessage(fauxText("fourth done")),
    ]);
    const third = send("third question");
    await host.settle();
    expect(summaries).toBe(1);
    expect(getTurn(host, third.turnId)?.status).toBe("waiting_for_browser");
    expect(host.events.find(item => item.event === "agent.context_compacted" && item.detail?.outcome === "deferred")?.detail?.errorCode).toBe("CONTEXT_COMPACTION_TIMEOUT");

    // The resume after the browser call goes on with the full history, without a second summary request.
    const { call } = claimBrowserCall(host);
    await completeBrowserCall(host, { callId: call!.callId, leaseId: call!.leaseId, result: { text: "tabs" } });
    await host.settle();
    expect(getTurn(host, third.turnId)?.finalAnswer).toBe("third done");
    expect(summaries).toBe(1);

    host.compaction = { ...host.compaction, compactAtTokens: 1 };
    const fourth = send("fourth question");
    await host.settle();
    expect(summaries).toBe(2);
    expect(getTurn(host, fourth.turnId)?.finalAnswer).toBe("fourth done");
  });
});
