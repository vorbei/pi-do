import { describe, expect, it } from "vitest";
import { fauxAssistantMessage, fauxText, fauxThinking, fauxToolCall, type Context } from "@earendil-works/pi-ai";
import { TURN_BUDGET, BROWSER_CALL_LEASE_MS, BROWSER_CLAIM_WAIT_MS, VISION_MODEL_NAME, modelProfile } from "../src/config.ts";
import { archiveThread, browserCallSignal, cancelTurn, claimBrowserCall, claimBrowserCallWaiting, completeBrowserCall, getTurn, listThreads, listTurns, recover, retryTurn, submitMessage, turnImage } from "../src/worker/turns.ts";
import { validateTurnProjection } from "agent-core/runtime";
import { migrate, one, rows } from "../src/worker/schema.ts";
import { checkpointMessages, readTurnCheckpoint } from "agent-core/pi";
import { loseResultsAfterLastCall, sqliteStorage, testHost, type TestHost } from "./helpers/host.ts";
import { OUTPUT_LIMIT_NOTICE } from "agent-core/guidance";

const context = { tabId: 7, url: "https://example.com/", title: "Example" };
let keys = 0;
const send = (host: TestHost, text: string, threadId = "thread1") =>
  submitMessage(host, { threadId, text, context, idempotencyKey: `key-${++keys}-abcdef` });

const toolUse = (args: Record<string, unknown>, id?: string) => fauxAssistantMessage(fauxToolCall("browser", args, id ? { id } : undefined), { stopReason: "toolUse" });
const answer = (text: string) => fauxAssistantMessage(fauxText(text));
const text = (content: unknown) => typeof content === "string" ? content
  : (content as { type: string; text?: string }[]).map(part => part.type === "text" ? part.text : "").join("");
// The last user message the model got, other than the runtime's budget line at the end of every request.
const lastUserText = (ctx: Context) => ctx.messages.filter(item => item.role === "user").map(item => text(item.content))
  .filter(content => !content.startsWith("Runtime budget:")).at(-1) ?? "";
// The thread's journal (agent-core's branch journal, as of its latest checkpoint), without the runtime's hidden host events.
const journal = (host: TestHost, threadId = "thread1") => {
  const latest = one<{ turn_id: string }>(host.storage, "SELECT turn_id FROM agent_turns WHERE thread_id = ? AND checkpoint_json LIKE '%piSession%' ORDER BY rowid DESC LIMIT 1", threadId);
  return (latest ? checkpointMessages(readTurnCheckpoint(host.storage, latest.turn_id)!) : [])
    .filter((message: { role: string }) => message.role !== "custom")
    .map((message: { role: string }) => ({ role: message.role, message_json: JSON.stringify(message) }));
};

describe("durable turns", () => {
  it("answers a message and journals the prompt with its tab context", async () => {
    const host = testHost();
    host.respond([answer("Hello there")]);
    const turn = send(host, "hi");
    await host.settle();
    expect(getTurn(host, turn.turnId)).toMatchObject({ status: "completed", finalAnswer: "Hello there", errorCode: null });
    const user = text(JSON.parse(journal(host)[0].message_json).content);
    expect(user).toContain('<browser_context tabId="7" url="https://example.com/"');
    expect(user).toContain("hi");
  });

  it("replays an idempotency key to the same turn and rejects a different payload", async () => {
    const host = testHost();
    host.respond([answer("ok")]);
    const first = submitMessage(host, { threadId: "t", text: "same", context: null, idempotencyKey: "fixed-key-1" });
    expect(submitMessage(host, { threadId: "t", text: "same", context: null, idempotencyKey: "fixed-key-1" }).turnId).toBe(first.turnId);
    expect(() => submitMessage(host, { threadId: "t", text: "other", context: null, idempotencyKey: "fixed-key-1" })).toThrow("IDEMPOTENCY_CONFLICT");
    await host.settle();
  });

  it("suspends on a browser call, and resumes with the extension's result in place of the placeholder", async () => {
    const host = testHost();
    host.respond([
      toolUse({ action: "snapshot", tabId: 7 }),
      ctx => {
        const result = ctx.messages.findLast(message => message.role === "toolResult");
        return answer(`saw: ${result?.role === "toolResult" && result.content[0].type === "text" ? result.content[0].text : "nothing"}`);
      },
    ]);
    const turn = send(host, "what is on the page?");
    await host.settle();
    expect(getTurn(host, turn.turnId)?.status).toBe("waiting_for_browser");
    expect(JSON.parse(journal(host).at(-1)!.message_json).details).toMatchObject({ callId: expect.stringMatching(/^call_/), status: "created" });

    const { call } = claimBrowserCall(host);
    expect(call).toMatchObject({ turnId: turn.turnId, call: { action: "snapshot", tabId: 7 } });
    expect(claimBrowserCall(host).call).toBeNull(); // a claimed call is not handed out again while its lease holds
    await completeBrowserCall(host, { callId: call!.callId, leaseId: call!.leaseId, result: { text: '- button "Go" [ref=e1]' } });
    // A repeated delivery is acknowledged, not applied twice; a different result for the same lease is refused.
    expect(await completeBrowserCall(host, { callId: call!.callId, leaseId: call!.leaseId, result: { text: '- button "Go" [ref=e1]' } })).toEqual({ accepted: true });
    await expect(completeBrowserCall(host, { callId: call!.callId, leaseId: call!.leaseId, result: { text: "other" } })).rejects.toThrow("FUNCTION_RESULT_CONFLICT");
    await host.settle();

    expect(getTurn(host, turn.turnId)).toMatchObject({ status: "completed", finalAnswer: 'saw: - button "Go" [ref=e1]' });
    expect(journal(host).map(entry => entry.role)).toEqual(["user", "assistant", "toolResult", "assistant"]);
    expect(journal(host)[2].message_json).not.toContain("Waiting for account function");
  });

  it("a waiting claim gets the call as soon as the model makes it, and an idle account answers at once", async () => {
    const host = testHost();
    host.browserCalls = browserCallSignal();
    expect(await claimBrowserCallWaiting(host, 5_000)).toEqual({ call: null, activeTurns: 0 });
    host.respond([toolUse({ action: "tabs" }), answer("done")]);
    const started = Date.now();
    send(host, "list tabs");
    // The model has not made its call yet: the claim waits for it.
    expect(claimBrowserCall(host).call).toBeNull();
    const { call } = await claimBrowserCallWaiting(host, 5_000);
    expect(call).toMatchObject({ call: { action: "tabs" } });
    expect(Date.now() - started).toBeLessThan(1_000);
    await completeBrowserCall(host, { callId: call!.callId, leaseId: call!.leaseId, result: { text: "tabs" } });
    await host.settle();
  });

  it("adds a page's guide to the first result on that page in a turn, and not again", async () => {
    const host = testHost();
    host.respond([toolUse({ action: "snapshot", tabId: 7 }), toolUse({ action: "snapshot", tabId: 7 }), answer("done")]);
    const turn = send(host, "find the 2020 paper");
    const page = "https://arxiv.org/search/advanced?terms-0-term=x";
    for (let index = 0; index < 2; index++) {
      await host.settle();
      const { call } = claimBrowserCall(host);
      await completeBrowserCall(host, { callId: call!.callId, leaseId: call!.leaseId, result: { text: `- searchbox "Search term" [ref=e${index}]`, pageUrl: page } });
    }
    await host.settle();
    expect(getTurn(host, turn.turnId)?.status).toBe("completed");
    const results = journal(host).filter(entry => entry.role === "toolResult").map(entry => JSON.parse(entry.message_json).content[0].text as string);
    expect(results[0]).toMatch(/<page_guide id="bundled:arxiv-advanced-search"[^]*Submission date \(original\)/);
    expect(results[1]).not.toContain("page_guide");
  });

  it("adds X's site-wide guide once per turn on any x.com page, and a page's own guide where one exists", async () => {
    const host = testHost();
    const pages = ["https://x.com/home", "https://x.com/home", "https://x.com/compose/articles", "https://x.com/alice/status/1"];
    const turnOf = () => {
      host.respond([...pages.map(() => toolUse({ action: "snapshot", tabId: 7 })), answer("done")]);
      return send(host, "tend my timeline");
    };
    const guidesIn = async () => {
      for (const pageUrl of pages) {
        await host.settle();
        const { call } = claimBrowserCall(host);
        await completeBrowserCall(host, { callId: call!.callId, leaseId: call!.leaseId, result: { text: '- article "post"', pageUrl } });
      }
      await host.settle();
      return journal(host).filter(entry => entry.role === "toolResult").slice(-pages.length)
        .map(entry => [...(JSON.parse(entry.message_json).content[0].text as string).matchAll(/<page_guide id="([^"]+)"/g)].map(match => match[1]));
    };
    const first = turnOf();
    expect(await guidesIn()).toEqual([["bundled:x-page"], [], ["bundled:x-articles-editor"], []]);
    expect(getTurn(host, first.turnId)?.status).toBe("completed");
    turnOf();
    expect((await guidesIn())[0]).toEqual(["bundled:x-page"]);
  });

  it("rejects a completion with a stale lease", async () => {
    const host = testHost();
    host.respond([toolUse({ action: "tabs" }), answer("done")]);
    send(host, "list tabs");
    await host.settle();
    const { call } = claimBrowserCall(host);
    await expect(completeBrowserCall(host, { callId: call!.callId, leaseId: "lease_wrong", result: { text: "x" } })).rejects.toThrow("FUNCTION_CALL_LEASE_INVALID");
  });

  it("resumes after the executor vanished mid-request, without replaying the prompt", async () => {
    const host = testHost();
    let calls = 0;
    host.streamFn = (model, ctx, options) => {
      calls++;
      if (calls === 1) return new Promise(() => {}) as never; // the isolate is evicted during this request
      return testHost().streamFn(model, ctx, options);
    };
    const turn = send(host, "resume me");
    await Promise.resolve();
    await new Promise(resolve => setTimeout(resolve, 10));
    expect(getTurn(host, turn.turnId)?.status).toBe("running");

    host.tasks.length = 0; // the stalled attempt is gone with its isolate
    const replacement = testHost();
    replacement.respond([answer("recovered answer")]);
    host.streamFn = replacement.streamFn;
    host.clock.now += 2 * modelProfile(host.model.id).timeoutMs + 1; // past the running lease: two of the model's deadlines
    await recover(host);
    await host.settle();

    expect(getTurn(host, turn.turnId)).toMatchObject({ status: "completed", finalAnswer: "recovered answer" });
    expect(journal(host).filter(entry => entry.role === "user")).toHaveLength(1);
    expect(host.events.some(item => item.event === "agent.turn.recovery_started")).toBe(true);
  });

  it("tells the model a browser call it asked for never started when the attempt died before queuing it; it may ask again", async () => {
    const host = testHost();
    let resumed = "";
    host.respond([toolUse({ action: "read_text", tabId: 7 }, "call-1"), ctx => {
      resumed = JSON.stringify(ctx.messages.findLast(message => message.role === "toolResult"));
      return toolUse({ action: "read_text", tabId: 7 }, "call-2");
    }, answer("text read")]);
    const turn = send(host, "read it");
    await host.settle();
    // Simulate a crash after the assistant tool call was journaled but before the placeholder and call row.
    loseResultsAfterLastCall(host, turn.turnId);
    host.storage.sql.exec("DELETE FROM agent_function_calls");
    host.storage.sql.exec("UPDATE agent_turns SET status = 'running', lease_id = 'lease_gone', lease_expires_at = ?", new Date(host.clock.now - 1).toISOString());
    await recover(host);
    await host.settle();
    expect(resumed).toContain("TOOL_NOT_STARTED");
    expect(getTurn(host, turn.turnId)?.status).toBe("waiting_for_browser");
    const { call } = claimBrowserCall(host);
    expect(call?.call).toEqual({ action: "read_text", tabId: 7 });
    await completeBrowserCall(host, { callId: call!.callId, leaseId: call!.leaseId, result: { text: "body" } });
    await host.settle();
    expect(getTurn(host, turn.turnId)?.finalAnswer).toBe("text read");
  });

  it("cancels a waiting turn: the call fails, the next turn reads that it was cancelled, the thread stays usable", async () => {
    const host = testHost();
    let history = "";
    host.respond([toolUse({ action: "click", tabId: 7, ref: "e3" }), ctx => { history = JSON.stringify(ctx.messages); return answer("next answer"); }]);
    const turn = send(host, "click it");
    await host.settle();
    const cancelled = cancelTurn(host, turn.turnId);
    expect(cancelled).toMatchObject({ status: "cancelled", errorCode: "TURN_CANCELLED" });
    expect(claimBrowserCall(host).call).toBeNull();

    const next = send(host, "something else");
    await host.settle();
    expect(getTurn(host, next.turnId)).toMatchObject({ status: "completed", finalAnswer: "next answer" });
    expect(history).toContain("Browser error TURN_CANCELLED: The user cancelled the turn");
    expect(history).not.toContain("Waiting for account function");
  });

  it("merges a steer sent while the turn waits for the browser into the resumed run", async () => {
    const host = testHost();
    let seenSteer = "";
    host.respond([
      toolUse({ action: "snapshot", tabId: 7 }),
      ctx => { seenSteer = lastUserText(ctx); return answer("adjusted"); },
    ]);
    const turn = send(host, "find the price");
    await host.settle();
    const steer = send(host, "actually, find the shipping cost");
    expect(getTurn(host, steer.turnId)?.status).toBe("queued");
    const { call } = claimBrowserCall(host);
    await completeBrowserCall(host, { callId: call!.callId, leaseId: call!.leaseId, result: { text: "page" } });
    await host.settle();

    expect(seenSteer).toContain("actually, find the shipping cost");
    expect(getTurn(host, turn.turnId)).toMatchObject({ status: "completed", finalAnswer: "adjusted" });
    expect(getTurn(host, steer.turnId)).toMatchObject({ status: "completed", mergedIntoTurnId: turn.turnId, input: "actually, find the shipping cost" });
    expect(listTurns(host, "thread1")).toMatchObject({ turns: [{ turnId: turn.turnId }, { turnId: steer.turnId }], nextBefore: null });
  });

  it("does not merge a steer that states another memory permission: it runs as its own turn, under its own permission", async () => {
    const host = testHost();
    const contexts: string[][] = [];
    const tools = (ctx: Context) => (ctx.tools ?? []).map(tool => tool.name);
    host.respond([
      toolUse({ action: "snapshot", tabId: 7 }),
      ctx => { contexts.push(tools(ctx)); return answer(lastUserText(ctx).includes("remember my address") ? "merged" : "first done"); },
      ctx => { contexts.push(tools(ctx)); return answer("second done"); },
    ]);
    const turn = submitMessage(host, { threadId: "thread1", text: "find the price", context, idempotencyKey: `key-${++keys}-abcdef`, memory: { update: false } });
    await host.settle();
    const steer = submitMessage(host, { threadId: "thread1", text: "remember my address", context, idempotencyKey: `key-${++keys}-abcdef`, memory: { update: true } });
    const { call } = claimBrowserCall(host);
    await completeBrowserCall(host, { callId: call!.callId, leaseId: call!.leaseId, result: { text: "page" } });
    await host.settle();

    expect(getTurn(host, turn.turnId)).toMatchObject({ status: "completed", finalAnswer: "first done" });
    expect(getTurn(host, steer.turnId)).toMatchObject({ status: "completed", finalAnswer: "second done" });
    expect(getTurn(host, steer.turnId)).not.toHaveProperty("mergedIntoTurnId");
    // The read-only turn never offered forget_memory; the steer's own turn did.
    expect(contexts[0]).not.toContain("forget_memory");
    expect(contexts[1]).toContain("forget_memory");
  });

  it("runs a message sent after the turn ended as its own turn", async () => {
    const host = testHost();
    host.respond([answer("first"), answer("second")]);
    send(host, "one");
    await host.settle();
    const later = send(host, "two");
    await host.settle();
    expect(getTurn(host, later.turnId)).toMatchObject({ status: "completed", finalAnswer: "second" });
    expect(getTurn(host, later.turnId)).not.toHaveProperty("mergedIntoTurnId");
  });

  it("fails a turn whose call nobody claims as CHROME_OFFLINE; the next message sees why", async () => {
    const host = testHost();
    host.respond([toolUse({ action: "tabs" }), ctx => answer(JSON.stringify(ctx.messages))]);
    const turn = send(host, "tabs?");
    await host.settle();
    host.clock.now += BROWSER_CLAIM_WAIT_MS + 1;
    await recover(host);
    await host.settle();
    expect(getTurn(host, turn.turnId)).toMatchObject({ status: "failed", errorCode: "CHROME_OFFLINE" });
    expect(claimBrowserCall(host).call).toBeNull();
    const next = send(host, "and now?");
    await host.settle();
    expect(getTurn(host, next.turnId)?.finalAnswer).toContain("The side panel may be closed");
  });

  it("hands an expired read out again, but a call that may have acted is claimed once and settles as EFFECT_UNKNOWN", async () => {
    const reads = testHost();
    reads.respond([toolUse({ action: "snapshot", tabId: 7 }), answer("read")]);
    send(reads, "look");
    await reads.settle();
    const read = claimBrowserCall(reads).call!;
    reads.clock.now += BROWSER_CALL_LEASE_MS + 1;
    const again = claimBrowserCall(reads).call!;
    expect(again.callId).toBe(read.callId);
    await completeBrowserCall(reads, { callId: again.callId, leaseId: again.leaseId, result: { text: "page" } });
    await reads.settle();

    const host = testHost();
    host.respond([toolUse({ action: "click", tabId: 7, ref: "e1" }), ctx => answer(JSON.stringify(ctx.messages.findLast(message => message.role === "toolResult")))]);
    const turn = send(host, "click it");
    await host.settle();
    expect(claimBrowserCall(host).call).toMatchObject({ tool: "browser", call: { action: "click" } });
    host.clock.now += BROWSER_CALL_LEASE_MS + 1;
    expect(claimBrowserCall(host).call).toBeNull();
    await recover(host);
    await host.settle();
    expect(getTurn(host, turn.turnId)?.finalAnswer).toContain("EFFECT_UNKNOWN");
  });

  it("drops the tables of earlier pi-do versions once, and keeps the account and memory", () => {
    // 0.1.6 and older: turns, browser calls and a journal of their own.
    const old = sqliteStorage();
    old.sql.exec("CREATE TABLE turns (seq INTEGER PRIMARY KEY, turn_id TEXT)");
    old.sql.exec("CREATE TABLE browser_calls (call_id TEXT PRIMARY KEY)");
    old.sql.exec("CREATE TABLE journal (seq INTEGER PRIMARY KEY, thread_id TEXT)");
    old.sql.exec("INSERT INTO journal (thread_id) VALUES ('old')");
    migrate(old);
    const tables = rows<{ name: string }>(old, "SELECT name FROM sqlite_master WHERE type = 'table'").map(row => row.name);
    expect(tables).not.toContain("turns");
    expect(tables).not.toContain("browser_calls");
    expect(tables).not.toContain("journal");
    expect(tables).toEqual(expect.arrayContaining(["account", "memories", "agent_turns", "agent_function_calls", "agent_tool_receipts", "pi_journal_entries"]));

    // Then agent-core's turn tables beside a flat journal and stored summaries: their turns go with the journal.
    const flat = sqliteStorage();
    flat.sql.exec("CREATE TABLE journal (seq INTEGER PRIMARY KEY, thread_id TEXT, turn_id TEXT, role TEXT, tool_call_id TEXT, message_json TEXT)");
    flat.sql.exec("CREATE TABLE compactions (thread_id TEXT, upto_seq INTEGER, summary TEXT, created_at INTEGER)");
    migrate(flat);
    flat.sql.exec("INSERT INTO account (singleton, account_id, token_hash, created_at) VALUES (1, 'acct', 'hash', 0)");
    flat.sql.exec("CREATE TABLE journal (seq INTEGER PRIMARY KEY, thread_id TEXT)");
    flat.sql.exec(`INSERT INTO agent_turns (turn_id, account_id, thread_id, session_id, runtime_version, status, phase, input_json,
      idempotency_key, input_hash, created_at, updated_at) VALUES ('t', 'acct', 'old', 'old', 'pi-do', 'completed', 'done', '{}', 'k', 'h', '', '')`);
    migrate(flat);
    expect(rows(flat, "SELECT name FROM sqlite_master WHERE name IN ('journal', 'compactions')")).toHaveLength(0);
    expect(rows(flat, "SELECT * FROM agent_turns")).toHaveLength(0);
    expect(rows(flat, "SELECT * FROM account")).toHaveLength(1);
    // A current account is left alone.
    flat.sql.exec(`INSERT INTO agent_turns (turn_id, account_id, thread_id, session_id, runtime_version, status, phase, input_json,
      idempotency_key, input_hash, created_at, updated_at) VALUES ('t2', 'acct', 'new', 'new', 'pi-do', 'completed', 'done', '{}', 'k2', 'h', '', '')`);
    migrate(flat);
    expect(rows(flat, "SELECT * FROM agent_turns")).toHaveLength(1);
  });

  it("an account from before agent_turns.partial_text gets the column and loses its turn_partials table", () => {
    const old = sqliteStorage();
    migrate(old);
    old.sql.exec("ALTER TABLE agent_turns DROP COLUMN partial_text");
    old.sql.exec(`INSERT INTO agent_turns (turn_id, account_id, thread_id, session_id, runtime_version, status, phase, input_json,
      idempotency_key, input_hash, created_at, updated_at) VALUES ('t', 'acct', 'thread', 'thread', 'pi-do', 'completed', 'done', '{}', 'k', 'h', '', '')`);
    old.sql.exec("CREATE TABLE turn_partials (turn_id TEXT PRIMARY KEY, text TEXT NOT NULL)");
    migrate(old);
    migrate(old);
    expect(rows(old, "SELECT name FROM sqlite_master WHERE name = 'turn_partials'")).toHaveLength(0);
    expect(rows(old, "SELECT turn_id, partial_text FROM agent_turns")).toEqual([{ turn_id: "t", partial_text: null }]);
  });

  it("sends the last allowed request without tools and stops at the model-call budget", async () => {
    let lastTools = -1;
    // The last request before the answer-repair reserve is the turn's last tool step.
    const host = testHost({ limits: { ...TURN_BUDGET, modelCalls: 3, answerRepairs: 1 } });
    const base = host.streamFn;
    host.streamFn = (model, ctx, options) => { lastTools = ctx.tools?.length ?? 0; return base(model, ctx, options); };
    host.respond([toolUse({ action: "tabs" }), answer("final without tools")]);
    const turn = send(host, "go");
    await host.settle();
    const { call } = claimBrowserCall(host);
    await completeBrowserCall(host, { callId: call!.callId, leaseId: call!.leaseId, result: { text: "tabs" } });
    await host.settle();
    expect(lastTools).toBe(0);
    expect(getTurn(host, turn.turnId)?.finalAnswer).toBe("final without tools");
    expect(host.requests).toBe(2);
  });

  it("waits for a browser call made with one request left, and answers with that last request", async () => {
    // No answer-repair reserve: the step before the last may still call a tool.
    const host = testHost({ limits: { ...TURN_BUDGET, modelCalls: 3, answerRepairs: 0 } });
    host.respond([toolUse({ action: "tabs" }), toolUse({ action: "snapshot", tabId: 7 }), answer("answered with the last request")]);
    const turn = send(host, "go");
    for (const text of ["tabs", "page"]) {
      await host.settle();
      const { call } = claimBrowserCall(host);
      await completeBrowserCall(host, { callId: call!.callId, leaseId: call!.leaseId, result: { text } });
    }
    await host.settle();
    expect(host.requests).toBe(3);
    expect(getTurn(host, turn.turnId)).toMatchObject({ status: "completed", finalAnswer: "answered with the last request" });
  });

  const DSML ='<｜DSML｜ calls>\n<｜DSML｜ invoke name="browser">\n<｜DSML｜ parameter name="action" string="true">read_text</｜DSML｜ parameter>\n</｜DSML｜ invoke>\n</｜DSML｜ calls>';

  it("does not save a tool call written as text as the answer: asks once, without tools, for prose", async () => {
    const tools: number[] = [];
    const host = testHost();
    const base = host.streamFn;
    host.streamFn = (model, ctx, options) => { tools.push(ctx.tools?.length ?? 0); return base(model, ctx, options); };
    host.respond([answer(DSML), ctx => answer(lastUserText(ctx).startsWith("[answer check]") ? "The page lists three prices." : "wrong")]);
    const turn = send(host, "what are the prices?");
    await host.settle();
    expect(getTurn(host, turn.turnId)).toMatchObject({ status: "completed", finalAnswer: "The page lists three prices.", errorCode: null });
    expect(tools).toEqual([4, 0]); // browser, search_memory, remember (no stated permission: no update) and run_code, then none
    expect(journal(host).map(entry => entry.role)).toEqual(["user", "assistant", "user", "assistant"]);
  });

  it("keeps the prose around tool-call markup without another request, and asks at most once", async () => {
    const host = testHost();
    host.respond([answer(`I could not finish.\n${DSML}`)]);
    const kept = send(host, "go");
    await host.settle();
    expect(getTurn(host, kept.turnId)?.finalAnswer).toBe("I could not finish.");
    expect(host.requests).toBe(1);
    expect(host.events.filter(item => item.event === "agent.output.tool_markup_stripped")).toEqual([{ event: "agent.output.tool_markup_stripped", detail: { turnId: kept.turnId, keptOriginal: false } }]);

    // Prose that mentions or shows tool-call markup is the answer, as written.
    const prose = "Qwen3 marks a call with\n<tool_call>{\"name\": \"search\"}</tool_call>\nand then waits.\n```xml\n<function_calls></function_calls>\n```";
    const mention = testHost();
    mention.respond([answer(prose)]);
    const written = send(mention, "how does Qwen3 call tools?");
    await mention.settle();
    expect(getTurn(mention, written.turnId)?.finalAnswer).toBe(prose);
    expect(mention.requests).toBe(1);
    expect(mention.events.some(item => item.event === "agent.output.tool_markup_stripped")).toBe(false);

    const twice = testHost();
    twice.respond([answer(DSML), answer(DSML)]);
    const again = send(twice, "go");
    await twice.settle();
    expect(twice.requests).toBe(2);
    // Markup is still the model's answer when nothing else is left (agent-core's rule, as in X Gardener): it is delivered as written.
    expect(getTurn(twice, again.turnId)).toMatchObject({ status: "completed", finalAnswer: DSML, errorCode: null });
  });

  it("asks for prose only while the turn's model budget has a request left", async () => {
    const host = testHost({ limits: { ...TURN_BUDGET, modelCalls: 1, answerRepairs: 0 } });
    host.respond([answer(DSML)]);
    const turn = send(host, "go");
    await host.settle();
    expect(host.requests).toBe(1);
    expect(getTurn(host, turn.turnId)).toMatchObject({ status: "completed", finalAnswer: DSML, errorCode: null });
  });

  it("asks once for a rewrite when the answer breaks the user's explicit word limit", async () => {
    const host = testHost();
    let request = "";
    host.respond([answer("word ".repeat(12).trim()), ctx => { request = lastUserText(ctx); return answer("Short answer now."); }]);
    const turn = send(host, "Explain it in under 10 words.");
    await host.settle();
    expect(request).toMatch(/has 12 words.*asked for at most 10/);
    expect(getTurn(host, turn.turnId)?.finalAnswer).toBe("Short answer now.");

    // Still too long after the one rewrite: the rewrite is kept, nothing more is asked.
    const stubborn = testHost();
    stubborn.respond([answer("word ".repeat(12).trim()), answer("word ".repeat(11).trim())]);
    const again = send(stubborn, "Explain it in under 10 words.");
    await stubborn.settle();
    expect(stubborn.requests).toBe(2);
    expect(getTurn(stubborn, again.turnId)?.finalAnswer).toBe("word ".repeat(11).trim());

    const fits = testHost();
    fits.respond([answer("Nine words or fewer here.")]);
    send(fits, "Explain it in under 10 words.");
    await fits.settle();
    expect(fits.requests).toBe(1);
  });

  it("retries a retryable model failure once, then completes", async () => {
    const host = testHost();
    host.respond([fauxAssistantMessage([], { stopReason: "error", errorMessage: "429 rate limited" }), answer("after retry")]);
    const turn = send(host, "retry");
    await host.settle();
    expect(getTurn(host, turn.turnId)).toMatchObject({ status: "queued", errorCode: "MODEL_HTTP_429" });
    host.clock.now += 6_000;
    await recover(host);
    await host.settle();
    expect(getTurn(host, turn.turnId)).toMatchObject({ status: "completed", finalAnswer: "after retry" });
  });

  it("answers after a response that spent its whole output budget reasoning: one retry without tools, told to answer now", async () => {
    const host = testHost();
    // The faux model counts output from the content: a small budget the reasoning fills.
    host.model = { ...host.model, maxTokens: 8 };
    const asked: { tools: number; system: string }[] = [];
    host.respond([
      fauxAssistantMessage([fauxThinking("Let me work out the position square by square. ".repeat(10))], { stopReason: "length" }),
      ctx => { asked.push({ tools: ctx.tools?.length ?? 0, system: ctx.systemPrompt ?? "" }); return answer("Qxf7#"); },
    ]);
    const turn = send(host, "solve the puzzle");
    await host.settle();
    expect(getTurn(host, turn.turnId)).toMatchObject({ status: "queued", errorCode: "MODEL_OUTPUT_LIMIT" });
    host.clock.now += 6_000;
    await recover(host);
    await host.settle();
    expect(getTurn(host, turn.turnId)).toMatchObject({ status: "completed", finalAnswer: "Qxf7#" });
    expect(asked).toHaveLength(1);
    expect(asked[0].tools).toBe(0);
    expect(asked[0].system.endsWith(OUTPUT_LIMIT_NOTICE)).toBe(true);
  });

  it("stops a turn from guessing addresses: after three pages failed to load, the next open is refused and the model answers", async () => {
    const host = testHost();
    const guesses = ["a.png", "b.png", "c.png", "d.png"].map(name => toolUse({ action: "open", url: `http://127.0.0.1:8796/${name}` }));
    host.respond([...guesses, ctx => answer(text((ctx.messages.findLast(message => message.role === "toolResult") as { content: unknown }).content))]);
    const turn = send(host, "find the puzzle image");
    await host.settle();
    for (let failed = 0; failed < 3; failed++) {
      const { call } = claimBrowserCall(host);
      expect(call?.call).toMatchObject({ action: "open" });
      await completeBrowserCall(host, { callId: call!.callId, leaseId: call!.leaseId, errorCode: "PAGE_LOAD_FAILED", message: "HTTP 404. The tab was closed." });
      await host.settle();
    }
    expect(claimBrowserCall(host).call).toBeNull();
    expect(getTurn(host, turn.turnId)?.status).toBe("completed");
    expect(getTurn(host, turn.turnId)?.finalAnswer).toMatch(/^Not run: 3 pages/);
    expect(rows(host.storage, "SELECT * FROM agent_function_calls")).toHaveLength(3);
  });

  it("rejects invalid browser arguments back to the model without queuing a call", async () => {
    const host = testHost();
    host.respond([toolUse({ action: "navigate", tabId: 7, url: "javascript:alert(1)" }), ctx => answer(JSON.stringify(ctx.messages.findLast(message => message.role === "toolResult")))]);
    const turn = send(host, "go");
    await host.settle();
    expect(getTurn(host, turn.turnId)?.finalAnswer).toContain("url must be an absolute http(s) URL");
    expect(rows(host.storage, "SELECT * FROM agent_function_calls")).toHaveLength(0);
  });

  it("stops at the turn's spend ceiling, and the user's retry runs it again with a new allowance", async () => {
    const host = testHost({ limits: { ...TURN_BUDGET, costUsd: 0.01 }, costUsd: 0.02 });
    host.respond([toolUse({ action: "snapshot", tabId: 7 }), answer("done after the retry")]);
    const turn = send(host, "look");
    await host.settle();
    const { call } = claimBrowserCall(host);
    await completeBrowserCall(host, { callId: call!.callId, leaseId: call!.leaseId, result: { text: "page" } });
    await host.settle();
    expect(getTurn(host, turn.turnId)).toMatchObject({ status: "failed", errorCode: "MODEL_TURN_SPEND_LIMIT" });
    expect(readTurnCheckpoint(host.storage, turn.turnId)?.budget.costUsd).toBeGreaterThan(0);
    expect(() => retryTurn(host, turn.turnId, "short")).toThrow("INVALID_IDEMPOTENCY_KEY");
    retryTurn(host, turn.turnId, "retry-key-1");
    await host.settle();
    expect(getTurn(host, turn.turnId)).toMatchObject({ status: "completed", finalAnswer: "done after the retry", errorCode: null });
    expect(() => retryTurn(host, turn.turnId, "retry-key-2")).toThrow("TURN_NOT_RETRYABLE");
  });

  it("lists a thread's turns a page at a time, oldest first", async () => {
    const host = testHost();
    host.respond([answer("one"), answer("two"), answer("three")]);
    const sent = [];
    for (const message of ["first", "second", "third"]) { sent.push(send(host, message)); await host.settle(); }
    const latest = listTurns(host, "thread1", { limit: 2 });
    expect(latest.turns.map(turn => turn.finalAnswer)).toEqual(["two", "three"]);
    expect(latest.nextBefore).toBe(sent[1].turnId);
    expect(listTurns(host, "thread1", { before: latest.nextBefore })).toMatchObject({ turns: [{ finalAnswer: "one" }], nextBefore: null });
  });

  it("projects each turn as agent-core's turn projection, with its progress from the step log", async () => {
    const host = testHost();
    host.respond([toolUse({ action: "snapshot", tabId: 7 }), answer("seen")]);
    const turn = send(host, "look at the page");
    await host.settle();
    const waiting = getTurn(host, turn.turnId)!;
    expect(validateTurnProjection(waiting, null, { listItem: true })).toBe(waiting);
    expect(waiting).toMatchObject({ status: "waiting_for_browser", input: "look at the page", finalAnswer: null,
      progress: { label: "snapshot · running", items: [{ label: "snapshot · running", tool: "browser" }] } });
    const { call } = claimBrowserCall(host);
    await completeBrowserCall(host, { callId: call!.callId, leaseId: call!.leaseId, result: { text: "page" } });
    await host.settle();
    expect(getTurn(host, turn.turnId)).toMatchObject({ status: "completed", finalAnswer: "seen",
      progress: { label: "How it worked", items: [{ label: "snapshot", tool: "browser" }] } });
  });

  it("lists threads by their latest activity, titled by their first message, with an active turn's status", async () => {
    const host = testHost();
    host.respond([answer("a1"), toolUse({ action: "snapshot", tabId: 7 })]);
    submitMessage(host, { threadId: "thread_a", text: "First   question\nin A", context, idempotencyKey: `key-${++keys}-abcdef` });
    await host.settle();
    submitMessage(host, { threadId: "thread_b", text: "Question in B", context, idempotencyKey: `key-${++keys}-abcdef` });
    await host.settle();
    expect(listThreads(host).threads).toMatchObject([
      { threadId: "thread_b", title: "Question in B", latestTurnStatus: "waiting_for_browser" },
      { threadId: "thread_a", title: "First question in A", latestTurnStatus: "completed" },
    ]);
    expect(listThreads(host, { limit: 1 }).threads.map(thread => thread.threadId)).toEqual(["thread_b"]);
  });

  it("deleting a thread archives it: it leaves the list, takes no message, and keeps its turns", async () => {
    const host = testHost();
    host.respond([answer("a1"), toolUse({ action: "snapshot", tabId: 7 })]);
    const first = submitMessage(host, { threadId: "thread_a", text: "Question in A", context, idempotencyKey: `key-${++keys}-abcdef` });
    await host.settle();
    submitMessage(host, { threadId: "thread_b", text: "Question in B", context, idempotencyKey: `key-${++keys}-abcdef` });
    await host.settle();
    expect(() => archiveThread(host, "thread_b")).toThrow("AGENT_THREAD_BUSY");
    expect(() => archiveThread(host, "thread_never")).toThrow("AGENT_THREAD_NOT_FOUND");
    const archived = archiveThread(host, "thread_a");
    expect(archived).toMatchObject({ threadId: "thread_a", status: "archived" });
    expect(archiveThread(host, "thread_a")).toEqual(archived);
    expect(listThreads(host).threads.map(thread => thread.threadId)).toEqual(["thread_b"]);
    expect(() => submitMessage(host, { threadId: "thread_a", text: "More", context, idempotencyKey: `key-${++keys}-abcdef` })).toThrow("AGENT_THREAD_NOT_ACTIVE");
    expect(getTurn(host, first.turnId)).toMatchObject({ status: "completed", finalAnswer: "a1" });
    expect(host.events.some(item => item.event === "agent.thread.archived")).toBe(true);
  });
});

describe("a message's images", () => {
  const PNG = { mimeType: "image/png" as const, data: "iVBORw0KGgoAAAANSUhEUg==" };
  const JPEG = { mimeType: "image/jpeg" as const, data: "/9j/4AAQSkZJRg==" };
  const sendImages = (host: TestHost, text: string, images = [PNG, JPEG], key = `key-${++keys}-abcdef`) =>
    submitMessage(host, { threadId: "thread1", text, context, idempotencyKey: key, images });
  // The image parts of the user messages the model got, in order.
  const userImages = (ctx: Context) => ctx.messages.filter(message => message.role === "user")
    .flatMap(message => Array.isArray(message.content) ? message.content.filter(part => part.type === "image") : []);

  it("sends the images to the model with the message's text, and lists them by type for the panel to load again", async () => {
    const host = testHost();
    const seen: { text: string; images: unknown[] }[] = [];
    host.respond([
      ctx => { seen.push({ text: lastUserText(ctx), images: userImages(ctx) }); return answer("A cat and a receipt."); },
      ctx => { seen.push({ text: lastUserText(ctx), images: userImages(ctx) }); return answer("Still the cat."); },
    ]);
    const turn = sendImages(host, "What is in these?");
    await host.settle();
    expect(seen[0].text).toContain("What is in these?");
    expect(seen[0].images).toEqual([{ type: "image", ...PNG }, { type: "image", ...JPEG }]);
    // A reload: the thread's turns name the images; their bytes are read one by one.
    const [listed] = listTurns(host, "thread1").turns;
    expect(listed).toMatchObject({ turnId: turn.turnId, status: "completed", input: "What is in these?", images: [{ mimeType: "image/png" }, { mimeType: "image/jpeg" }] });
    expect(JSON.stringify(listed)).not.toContain(PNG.data);
    expect(validateTurnProjection(listed, null, { listItem: true, fields: ["images"] })).toBe(listed);
    expect(turnImage(host, turn.turnId, 1)).toEqual(JPEG);
    expect(turnImage(host, turn.turnId, 2)).toBeNull();
    // The thread's next message keeps the images in its history; a message without images lists none.
    const next = send(host, "And now?");
    await host.settle();
    expect(seen[1].images).toHaveLength(2);
    expect(getTurn(host, next.turnId)).not.toHaveProperty("images");
  });

  it("runs a turn whose message carries images on the vision model, and a turn without images on the default model", async () => {
    const host = testHost();
    host.visionModel = { ...host.model, id: VISION_MODEL_NAME, cost: { ...modelProfile(VISION_MODEL_NAME).cost } };
    const inner = host.streamFn;
    const models: string[] = [];
    host.streamFn = ((model, ctx, options) => { models.push(model.id); return inner(model, ctx, options); }) as typeof host.streamFn;
    host.respond([answer("A chess board."), answer("Plain text.")]);
    sendImages(host, "Solve this", [PNG]);
    await host.settle();
    send(host, "And without an image?");
    await host.settle();
    expect(models).toEqual([VISION_MODEL_NAME, host.model.id]);
  });

  it("sends a request to the vision model when it answers a screenshot or the vision model's own tap; text reads go back to the default one", async () => {
    const host = testHost();
    host.visionModel = { ...host.model, id: VISION_MODEL_NAME, cost: { ...modelProfile(VISION_MODEL_NAME).cost } };
    const inner = host.streamFn;
    const models: string[] = [];
    const imagesSeen: number[] = [];
    host.streamFn = ((model, ctx, options) => {
      models.push(model.id);
      imagesSeen.push(ctx.messages.flatMap(message => Array.isArray(message.content) ? message.content as { type: string }[] : [])
        .filter(block => block.type === "image").length);
      return inner(model, ctx, options);
    }) as typeof host.streamFn;
    host.respond([toolUse({ action: "screenshot", tabId: 7 }), toolUse({ action: "click", tabId: 7, ref: "e3" }),
      toolUse({ action: "snapshot", tabId: 7 }), answer("Tapped the board."), answer("Plain text.")]);
    send(host, "Tap the black king on the phone page");
    await host.settle();
    for (const result of [{ text: "screen", image: JPEG }, { text: "tapped" }, { text: "- button \"Continue\" [ref=e7]" }]) {
      const { call } = claimBrowserCall(host);
      await completeBrowserCall(host, { callId: call!.callId, leaseId: call!.leaseId, result });
      await host.settle();
    }
    send(host, "And next?");
    await host.settle();
    // The screenshot and the result of the vision model's own tap go to it; after its text read the
    // default model answers, and the next turn starts there.
    expect(models).toEqual([host.model.id, VISION_MODEL_NAME, VISION_MODEL_NAME, host.model.id, host.model.id]);
    // The vision model sees the screenshot; the default model's requests get a stub in its place.
    expect(imagesSeen).toEqual([0, 1, 1, 0, 0]);
  });

  it("hands the vision model's server read (a memory search) back to the default model", async () => {
    const host = testHost();
    host.visionModel = { ...host.model, id: VISION_MODEL_NAME, cost: { ...modelProfile(VISION_MODEL_NAME).cost } };
    const inner = host.streamFn;
    const models: string[] = [];
    host.streamFn = ((model, ctx, options) => { models.push(model.id); return inner(model, ctx, options); }) as typeof host.streamFn;
    host.respond([toolUse({ action: "screenshot", tabId: 7 }),
      fauxAssistantMessage(fauxToolCall("search_memory", { query: "chess engine" }), { stopReason: "toolUse" }), answer("Done.")]);
    send(host, "Solve the puzzle on the phone page");
    await host.settle();
    const { call } = claimBrowserCall(host);
    await completeBrowserCall(host, { callId: call!.callId, leaseId: call!.leaseId, result: { text: "screen", image: JPEG } });
    await host.settle();
    // The screenshot goes to the vision model; its memory search's result is text the default model reads.
    expect(models).toEqual([host.model.id, VISION_MODEL_NAME, host.model.id]);
  });

  it("takes a message of images alone, but not an empty one", async () => {
    const host = testHost();
    let images: unknown[] = [];
    host.respond([ctx => { images = userImages(ctx); return answer("A screenshot."); }]);
    const turn = sendImages(host, "", [PNG]);
    await host.settle();
    expect(images).toEqual([{ type: "image", ...PNG }]);
    expect(getTurn(host, turn.turnId)).toMatchObject({ status: "completed", input: "", images: [{ mimeType: "image/png" }] });
    expect(() => sendImages(host, " ", [])).toThrow("INVALID_TURN_INPUT");
  });

  it("delivers a steer's images to the running turn", async () => {
    const host = testHost();
    let steered: unknown[] = [];
    host.respond([toolUse({ action: "snapshot", tabId: 7 }), ctx => { steered = userImages(ctx); return answer("adjusted"); }]);
    const turn = send(host, "find the price");
    await host.settle();
    const steer = sendImages(host, "this one", [JPEG]);
    const { call } = claimBrowserCall(host);
    await completeBrowserCall(host, { callId: call!.callId, leaseId: call!.leaseId, result: { text: "page" } });
    await host.settle();
    expect(steered).toEqual([{ type: "image", ...JPEG }]);
    expect(getTurn(host, steer.turnId)).toMatchObject({ mergedIntoTurnId: turn.turnId, images: [{ mimeType: "image/jpeg" }] });
  });

  it("refuses images for a model that cannot read them, and replays a key only with the same images", async () => {
    const host = testHost();
    host.respond([answer("ok")]);
    const first = sendImages(host, "same", [PNG], "image-key-1");
    expect(sendImages(host, "same", [PNG], "image-key-1").turnId).toBe(first.turnId);
    expect(() => sendImages(host, "same", [{ ...PNG, data: "iVBORw0KGgoAAAANSUhEUw==" }], "image-key-1")).toThrow("IDEMPOTENCY_CONFLICT");
    expect(() => sendImages(host, "same", [], "image-key-1")).toThrow("IDEMPOTENCY_CONFLICT");
    await host.settle();
    const textOnly = testHost();
    textOnly.model = { ...textOnly.model, input: ["text"] };
    expect(() => sendImages(textOnly, "What is this?", [PNG])).toThrow("MODEL_IMAGE_INPUT_UNSUPPORTED");
    expect(listTurns(textOnly, "thread1").turns).toEqual([]);
    expect(rows(textOnly.storage, "SELECT turn_id FROM turn_images")).toEqual([]);
  });
});

describe("run_code", () => {
  const runCode = (args: Record<string, unknown>) => fauxAssistantMessage(fauxToolCall("run_code", args), { stopReason: "toolUse" });
  const lastResult = (ctx: Context) => {
    const result = ctx.messages.findLast(message => message.role === "toolResult");
    return result?.role === "toolResult" ? { text: text(result.content), isError: result.isError } : null;
  };
  // The extension's side: claim the waiting run and complete it with what its sandbox returned.
  const runInExtension = async (host: TestHost, result: (call: { language: string; code: string }) => unknown) => {
    const claimed = claimBrowserCall(host).call!;
    expect(claimed.tool).toBe("run_code");
    await completeBrowserCall(host, { callId: claimed.callId, leaseId: claimed.leaseId, result: result(claimed.call as { language: string; code: string }) });
    await host.settle();
  };

  it("is queued for the extension like a browser action, and the model reads the run's output; shown as a run_code step", async () => {
    const host = testHost();
    host.respond([
      ctx => { expect(ctx.tools?.map(tool => tool.name)).toContain("run_code");
        return runCode({ language: "bash", code: "sort words.txt | uniq -c", files: { "words.txt": "pear\napple\npear\n" } }); },
      ctx => answer(`computed: ${JSON.stringify(lastResult(ctx))}`),
    ]);
    const turn = send(host, "Count the words");
    await host.settle();
    // Nothing runs on the Worker: the turn waits for the extension, which receives the whole request.
    expect(getTurn(host, turn.turnId)?.status).toBe("waiting_for_browser");
    const first = claimBrowserCall(host).call!;
    expect(first).toMatchObject({ tool: "run_code", call: { language: "bash", code: "sort words.txt | uniq -c", files: { "words.txt": "pear\napple\npear\n" } } });
    // A code run changes nothing, so a claim whose lease ran out is handed out again.
    host.clock.now += BROWSER_CALL_LEASE_MS + 1;
    const again = claimBrowserCall(host).call!;
    expect(again.callId).toBe(first.callId);
    await completeBrowserCall(host, { callId: again.callId, leaseId: again.leaseId,
      result: { ok: true, stdout: "      1 apple\n      2 pear\n", stderr: "", exitCode: 0, logs: [], truncated: false } });
    await host.settle();
    expect(getTurn(host, turn.turnId)).toMatchObject({ status: "completed",
      finalAnswer: 'computed: {"text":"      1 apple\\n      2 pear\\n\\nexit status 0","isError":false}',
      progress: { label: "How it worked", items: [{ label: "run_code", tool: "run_code" }] } });
  });

  it("gives the model a failed run as a tool error with its code and console lines", async () => {
    const host = testHost();
    host.respond([runCode({ code: "console.log('parsed 2 rows'); throw new TypeError('rows[2] is undefined');" }), ctx => answer(JSON.stringify(lastResult(ctx)))]);
    const turn = send(host, "Sum the table");
    await host.settle();
    await runInExtension(host, call => {
      expect(call.language).toBe("js");
      return { ok: false, error: { code: "CODE_ERROR", message: "rows[2] is undefined", name: "TypeError" }, logs: ["parsed 2 rows"], truncated: false };
    });
    const seen = JSON.parse(getTurn(host, turn.turnId)!.finalAnswer!);
    expect(seen.isError).toBe(true);
    expect(seen.text).toContain("run_code failed (CODE_ERROR): TypeError: rows[2] is undefined");
    expect(seen.text).toContain("parsed 2 rows");
  });

  it("refuses code runs past the turn's ceiling before queueing them; each call also counts against the tool budget", async () => {
    const host = testHost({ limits: { ...TURN_BUDGET, codeRuns: 2 } });
    const results: ReturnType<typeof lastResult>[] = [];
    host.respond([
      runCode({ code: "return 1;" }),
      ctx => { results.push(lastResult(ctx)); return runCode({ code: "return 2;" }); },
      ctx => { results.push(lastResult(ctx)); return runCode({ code: "return 3;" }); },
      ctx => { results.push(lastResult(ctx)); return answer("done"); },
    ]);
    const turn = send(host, "Count with code");
    await host.settle();
    for (let run = 0; run < 2; run++) await runInExtension(host, call => ({ ok: true, value: call.code.match(/\d/)![0], logs: [], truncated: false }));
    expect(getTurn(host, turn.turnId)?.status).toBe("completed");
    expect(results.map(result => result?.text.split("\n")[0])).toEqual(["1", "2", expect.stringMatching(/^RUN_CODE_LIMIT/)]);
    expect(results[2]?.isError).toBe(true);
    expect(rows(host.storage, "SELECT call_id FROM agent_function_calls WHERE function_name = 'run_code'")).toHaveLength(2);
    const budget = readTurnCheckpoint(host.storage, turn.turnId)!.budget as { codeExecCallIds: string[]; toolCallIds: string[] };
    expect(budget.codeExecCallIds).toHaveLength(2);
    expect(budget.toolCallIds).toHaveLength(3);
  });

  it("runs only while the extension is online: a run nobody claims fails the turn as CHROME_OFFLINE", async () => {
    const host = testHost();
    host.respond([runCode({ code: "return 1;" }), answer("unreachable")]);
    const turn = send(host, "compute");
    await host.settle();
    host.clock.now += BROWSER_CLAIM_WAIT_MS + 1;
    await recover(host);
    await host.settle();
    expect(getTurn(host, turn.turnId)).toMatchObject({ status: "failed", errorCode: "CHROME_OFFLINE" });
  });

  it("refuses a malformed run result from the extension", async () => {
    const host = testHost();
    host.respond([runCode({ code: "return 1;" }), answer("done")]);
    send(host, "compute");
    await host.settle();
    const claimed = claimBrowserCall(host).call!;
    await expect(completeBrowserCall(host, { callId: claimed.callId, leaseId: claimed.leaseId, result: { text: "a page" } })).rejects.toThrow("INVALID_RESULT");
  });
});
