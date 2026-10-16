import { describe, expect, it } from "vitest";
import { fauxAssistantMessage, fauxText, fauxToolCall, type Context } from "@earendil-works/pi-ai";
import { getTurn, recover, submitMessage } from "../src/worker/turns.ts";
import { memoryTools } from "../src/worker/memory-tools.ts";
import { confirmByUser, forgetByUser, memoryView } from "../src/worker/memory-view.ts";
import { rows } from "../src/worker/schema.ts";
import { confirmInstruction, listInstructions, remember } from "agent-core/memory";
import { loseResultsAfterLastCall, receiptRecorder, testHost, type TestHost } from "./helpers/host.ts";

let keys = 0;
const send = (host: TestHost, text: string, threadId: string, update = true) =>
  submitMessage(host, { threadId, text, context: null, idempotencyKey: `memory-key-${++keys}`, memory: { update } });
const call = (name: string, args: Record<string, unknown>, id?: string) => fauxAssistantMessage(fauxToolCall(name, args, id ? { id } : undefined), { stopReason: "toolUse" });
const active = (host: TestHost) => rows<{ memory_id: string; content: string }>(host.storage, "SELECT memory_id, content FROM memories WHERE status = 'active'");
const lastToolText = (ctx: Context) => {
  const result = ctx.messages.findLast(message => message.role === "toolResult");
  return result?.role === "toolResult" && result.content[0].type === "text" ? result.content[0].text : "";
};

describe("long-term memory", () => {
  it("persists across chats and is used in the next turn: a saved fact is found, a confirmed instruction reaches the prompt", async () => {
    const host = testHost();
    host.respond([
      call("remember", { kind: "fact", content: "The user's dog is named Bruno." }),
      call("remember", { kind: "instruction", content: "Answer in French." }),
      fauxAssistantMessage(fauxText("Noted.")),
    ]);
    send(host, "Remember that my dog is Bruno, and always answer in French.", "chat-one");
    await host.settle();

    // A different chat: the fact is found by search, the instruction waits for the user.
    let prompt = "";
    host.respond([
      ctx => { prompt = ctx.systemPrompt ?? ""; return call("search_memory", { query: "dog" }); },
      ctx => fauxAssistantMessage(fauxText(lastToolText(ctx).includes("Bruno") ? "Your dog is Bruno." : "I do not know.")),
    ]);
    const second = send(host, "What is my dog's name?", "chat-two");
    await host.settle();
    expect(getTurn(host, second.turnId)?.finalAnswer).toBe("Your dog is Bruno.");
    expect(prompt).not.toContain("Answer in French.");

    const [instruction] = listInstructions(host.storage);
    expect(instruction).toMatchObject({ content: "Answer in French.", confirmed: false });
    confirmInstruction(host.storage, instruction.memoryId);
    host.respond([ctx => { prompt = ctx.systemPrompt ?? ""; return fauxAssistantMessage(fauxText("Bonjour.")); }]);
    send(host, "Hello", "chat-three");
    await host.settle();
    expect(prompt).toMatch(/<account-instructions>\n- Answer in French\.\n<\/account-instructions>/);
  });

  it("without the update permission, a fact is refused and nothing is forgotten; a new instruction still waits for confirmation", async () => {
    const host = testHost();
    let tools: string[] = [];
    host.respond([
      ctx => { tools = (ctx.tools ?? []).map(tool => tool.name); return call("remember", { kind: "fact", content: "Lives in Berlin." }); },
      ctx => { expect(lastToolText(ctx)).toContain("MEMORY_UPDATE_NOT_ALLOWED"); return call("remember", { kind: "instruction", content: "Be brief." }); },
      fauxAssistantMessage(fauxText("ok")),
    ]);
    send(host, "remember things", "chat-ro", false);
    await host.settle();
    expect(tools).toEqual(["browser", "search_memory", "remember", "run_code"]);
    expect(listInstructions(host.storage).map(item => [item.content, item.confirmed])).toEqual([["Be brief.", false]]);
    expect(host.storage.sql.exec("SELECT COUNT(*) AS n FROM memories WHERE kind = 'fact'").toArray()).toEqual([{ n: 0 }]);
  });

  it("a replayed remember call (same tool-call id) changes memory once and returns the same result, even when it replaces a memory", async () => {
    const host = testHost();
    const old = remember(host.storage, { kind: "fact", content: "Lives in Berlin.", sourceType: "agent" });
    const [, save] = memoryTools(host.storage, "turn_replay", { update: true }, () => true, receiptRecorder(host, "turn_replay"));
    const args = { kind: "fact", content: "Lives in Paris.", supersedes: old.memory_id };
    const first = await save.execute("tool-call-1", args);
    const again = await save.execute("tool-call-1", args);
    expect(again).toEqual(first);
    expect(active(host).map(row => row.content)).toEqual(["Lives in Paris."]);
    expect(host.storage.sql.exec("SELECT COUNT(*) AS n FROM memories WHERE content = 'Lives in Paris.'").toArray()).toEqual([{ n: 1 }]);
  });

  it("a turn recovered after its remember call ran, but before the result was journaled, gets the recorded result instead of 'did not run'", async () => {
    const host = testHost();
    host.respond([call("remember", { kind: "fact", content: "The user's cat is Miso." }, "remember-1"), fauxAssistantMessage(fauxText("Saved."))]);
    const turn = send(host, "Remember my cat is Miso.", "chat-replay");
    await host.settle();
    const [saved] = active(host);
    // The attempt is lost after the memory was written: no result and no answer reached the journal.
    loseResultsAfterLastCall(host, turn.turnId);
    host.storage.sql.exec("UPDATE agent_turns SET status = 'running', final_answer = NULL, lease_id = 'lease_gone', lease_expires_at = ?", new Date(host.clock.now - 1).toISOString());

    let seen = "";
    host.respond([ctx => { seen = lastToolText(ctx); return fauxAssistantMessage(fauxText("Saved: Miso.")); }]);
    await recover(host);
    await host.settle();
    expect(getTurn(host, turn.turnId)?.finalAnswer).toBe("Saved: Miso.");
    expect(seen).toContain(saved.memory_id);
    expect(seen).not.toContain("did not run");
    expect(active(host)).toHaveLength(1);
  });
});

describe("the user's Memory view", () => {
  it("lists instructions, facts and events (not expired or forgotten ones), and the user can remove each", () => {
    const host = testHost();
    const now = "2026-10-09T12:00:00.000Z";
    const save = (kind: "fact" | "event" | "instruction", content: string, expiresAt?: string) =>
      remember(host.storage, { kind, content, sourceType: "agent", expiresAt }, now).memory_id;
    const rule = save("instruction", "Answer briefly.");
    const fact = save("fact", "Works at Acme.");
    const event = save("event", "Flying to Lisbon on Friday.", "2026-10-11T00:00:00.000Z");
    save("event", "Dentist yesterday.", "2026-10-08T00:00:00.000Z");
    const gone = save("fact", "Old phone number.");
    forgetByUser(host.storage, gone);

    const view = memoryView(host.storage, now);
    expect(view.instructions.map(item => [item.memoryId, item.confirmed])).toEqual([[rule, false]]);
    expect(view.memories.map(item => [item.kind, item.content]).sort()).toEqual([["event", "Flying to Lisbon on Friday."], ["fact", "Works at Acme."]]);
    expect(view.memories.find(item => item.memoryId === event)?.expiresAt).toBe("2026-10-11T00:00:00.000Z");

    expect(forgetByUser(host.storage, fact)).toMatchObject({ memoryId: fact, forgotten: true });
    expect(memoryView(host.storage, now).memories.map(item => item.memoryId)).toEqual([event]);
  });

  // Depends on agent-core's forgetMemory(storage, id, { userInitiated }) (refuses a confirmed memory without it).
  it("the user removes an instruction they confirmed; the agent's forget_memory leaves it in place", async () => {
    const host = testHost();
    const first = remember(host.storage, { kind: "instruction", content: "Answer in French.", sourceType: "agent" }).memory_id;
    const second = remember(host.storage, { kind: "instruction", content: "Cite sources.", sourceType: "agent" }).memory_id;
    confirmByUser(host.storage, first);
    confirmByUser(host.storage, second);

    const [, , forget] = memoryTools(host.storage, "turn_agent", { update: true }, () => true, receiptRecorder(host, "turn_agent"));
    const result = await forget.execute("forget-1", { memoryId: first });
    expect(JSON.parse((result.content[0] as { text: string }).text)).toMatchObject({ forgotten: false, reason: "user_confirmed" });
    expect(forgetByUser(host.storage, second)).toMatchObject({ forgotten: true });
    expect(memoryView(host.storage).instructions.map(item => item.memoryId)).toEqual([first]);
  });
});
