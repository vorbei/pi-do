import { describe, expect, it, vi } from "vitest";
import { fauxAssistantMessage, fauxText, fauxToolCall } from "@earendil-works/pi-ai";
import { alarmJobs, runAlarm, type AlarmHost } from "agent-core/routine";
import { checkpointMessages, readTurnCheckpoint } from "agent-core/pi";
import { BROWSER_CLAIM_WAIT_MS } from "../src/config.ts";
import { confirmationReason, type BrowserCall } from "../src/shared/protocol.ts";
import { alarmHost, createRoutine, deleteRoutine, getRoutine, listRoutines, routineHost, runRoutine, updateRoutine } from "../src/worker/routines.ts";
import { claimBrowserCall, getTurn, hasOpenTurns, listThreads, recover, submitMessage } from "../src/worker/turns.ts";
import { migrate, one, rows } from "../src/worker/schema.ts";
import { sqliteStorage, testHost, type TestHost } from "./helpers/host.ts";

vi.mock("cloudflare:workers", () => ({ DurableObject: class {} }));

const toolUse = (args: Record<string, unknown>) => fauxAssistantMessage(fauxToolCall("browser", args), { stopReason: "toolUse" });
const answer = (text: string) => fauxAssistantMessage(fauxText(text));
const EVERY_DAY = { days: [0, 1, 2, 3, 4, 5, 6], localTime: "09:00", timezone: "UTC" };
let keys = 0;
const save = (over: Record<string, unknown> = {}) => ({ title: "Morning tabs", routinePrompt: "Summarize the news on example.com.", enabled: true,
  schedule: EVERY_DAY, idempotencyKey: `routine-save:${++keys}-abcdef`, ...over });

// pi-do's Routines over a test turn host and the object's alarm, as the AccountDO binds them.
function fixture(): { host: TestHost; alarms: AlarmHost; routines: ReturnType<typeof routineHost>; armed: number[] } {
  const host = testHost();
  const armed: number[] = [];
  const storage = Object.assign(host.storage, { setAlarm: (at: number) => { armed.push(at); }, deleteAlarm: () => { armed.push(-1); } });
  const alarms = alarmHost(storage, { log: () => {}, nextDeadline: () => undefined, routines: () => routines });
  const routines = routineHost(host, alarms);
  return { host, alarms, routines, armed };
}
// The first user message of a thread's journal.
const firstMessage = (host: TestHost, threadId: string) => {
  const turn = one<{ turn_id: string }>(host.storage, "SELECT turn_id FROM agent_turns WHERE thread_id = ? ORDER BY rowid LIMIT 1", threadId)!;
  const user = checkpointMessages(readTurnCheckpoint(host.storage, turn.turn_id)!).find((message: { role: string }) => message.role === "user") as { content: unknown };
  return typeof user.content === "string" ? user.content : (user.content as { text?: string }[]).map(part => part.text ?? "").join("");
};

describe("Routines", () => {
  it("are read-only unless allowed, arm the object's alarm, and a due alarm opens a run whose first turn is the prompt", async () => {
    const { host, alarms, routines, armed } = fixture();
    const created = await createRoutine(routines, save());
    const threadId = created.thread.threadId;
    expect(created.thread).toMatchObject({ title: "Morning tabs", permissions: { update: false, write: false }, routinePrompt: "Summarize the news on example.com." });
    expect(created.thread.schedule?.nextAt).toEqual(expect.any(String));
    expect(alarmJobs(alarms)).toHaveLength(1);
    expect(armed.at(-1)).toBeGreaterThan(0);

    host.respond([answer("Three stories.")]);
    claimBrowserCall(host); // the side panel is open: it looked for browser calls just now
    host.storage.sql.exec("UPDATE alarm_jobs SET due_at = 1");
    await runAlarm(alarms);
    await host.settle();
    const [run] = getRoutine(routines, threadId).runs;
    expect(run).toMatchObject({ parentThreadId: threadId, trigger: "schedule", latestTurnStatus: "completed", latestTurnSummary: "Three stories." });
    expect(firstMessage(host, run.threadId)).toContain("Summarize the news on example.com.");
    expect(firstMessage(host, run.threadId)).toContain("no tab selected");
    // The run is a thread of the chat list, named by its Routine and marked by what started it.
    expect(listThreads(host).threads.find(thread => thread.threadId === run.threadId)).toMatchObject({ title: "Morning tabs", parentThreadId: threadId, trigger: "schedule" });
    expect(alarmJobs(alarms)).toHaveLength(1);
    expect(alarmJobs(alarms)[0].payload.scheduledFor).not.toBe(created.thread.schedule?.nextAt);
    expect(listRoutines(routines).items[0].lastRun).toMatchObject({ threadId: run.threadId, status: "completed" });
  });

  it("a scheduled run with no side panel open is recorded as browser-offline at once, without a model call, and not retried", async () => {
    const { host, alarms, routines } = fixture();
    const { thread } = await createRoutine(routines, save());
    claimBrowserCall(host);
    host.clock.now += BROWSER_CLAIM_WAIT_MS; // the panel last looked a claim wait ago: it is gone
    host.respond([answer("never asked")]);
    host.storage.sql.exec("UPDATE alarm_jobs SET due_at = 1");
    await runAlarm(alarms);
    await host.settle();
    const [run] = getRoutine(routines, thread.threadId).runs;
    expect(run).toMatchObject({ trigger: "schedule", latestTurnStatus: "failed" });
    const turn = one<{ turn_id: string }>(host.storage, "SELECT turn_id FROM agent_turns WHERE thread_id = ?", run.threadId)!;
    expect(getTurn(host, turn.turn_id)).toMatchObject({ status: "failed", errorCode: "CHROME_OFFLINE" });
    expect(host.requests).toBe(0);
    expect(hasOpenTurns(host)).toBe(false);
    // The panel coming back starts nothing by itself; the Routine's next slot is armed as usual.
    claimBrowserCall(host);
    await recover(host);
    await host.settle();
    expect(host.requests).toBe(0);
    expect(alarmJobs(alarms)).toHaveLength(1);
    // A run started by hand is not held back: the user is at the panel.
    host.respond([answer("Read it.")]);
    expect(await runRoutine(routines, thread.threadId, { idempotencyKey: "routine-run:manual-after-offline" })).toMatchObject({ allowed: true, created: true });
    await host.settle();
    expect(host.requests).toBe(1);
  });

  it("a read-only run is refused any page action before it is queued, and keeps reading", async () => {
    const { host, routines } = fixture();
    const { thread } = await createRoutine(routines, save({ enabled: false }));
    host.respond([toolUse({ action: "click", tabId: 7, ref: "e1" }), answer("Could only read.")]);
    const result = await runRoutine(routines, thread.threadId, { idempotencyKey: "routine-run:ro-1" });
    await host.settle();
    expect(result).toMatchObject({ allowed: true, created: true, thread: { trigger: "manual", permissions: { update: false, write: false } } });
    expect(rows(host.storage, "SELECT call_id FROM agent_function_calls")).toHaveLength(0);
    const turn = one<{ turn_id: string }>(host.storage, "SELECT turn_id FROM agent_turns WHERE thread_id = ?", result.allowed ? result.thread.threadId : "")!;
    expect(getTurn(host, turn.turn_id)).toMatchObject({ status: "completed", finalAnswer: "Could only read." });
    expect(JSON.stringify(checkpointMessages(readTurnCheckpoint(host.storage, turn.turn_id)!))).toContain("may only read");
  });

  it("a run allowed to act queues a committing click for the extension, which asks the user before it runs", async () => {
    const { host, routines } = fixture();
    const { thread } = await createRoutine(routines, save({ enabled: false, permissions: { update: false, write: true } }));
    host.respond([toolUse({ action: "click", tabId: 7, ref: "e3" }), answer("Sent after approval.")]);
    const result = await runRoutine(routines, thread.threadId, { idempotencyKey: "routine-run:act-1", permissions: { update: false, write: true } });
    await host.settle();
    const runThread = result.allowed ? result.thread.threadId : "";
    const turn = one<{ turn_id: string }>(host.storage, "SELECT turn_id FROM agent_turns WHERE thread_id = ?", runThread)!;
    // The Worker approves nothing: the turn waits for the extension, whose executor asks first.
    expect(getTurn(host, turn.turn_id)?.status).toBe("waiting_for_browser");
    const { call } = claimBrowserCall(host);
    expect(call).toMatchObject({ threadId: runThread, call: { action: "click", ref: "e3" } });
    expect(call?.tool).toBe("browser");
    expect(confirmationReason(call!.call as BrowserCall, { role: "button", name: "Send" }, null)).toBe('click button "Send"');
  });

  it("a run no browser picks up fails as CHROME_OFFLINE after the claim wait, and the Routine can run again", async () => {
    const { host, routines } = fixture();
    const { thread } = await createRoutine(routines, save({ enabled: false }));
    host.respond([toolUse({ action: "snapshot", tabId: 7 })]);
    const first = await runRoutine(routines, thread.threadId, { idempotencyKey: "routine-run:off-1" });
    await host.settle();
    // While the run waits, the Routine is busy: another run is refused, not queued.
    expect(await runRoutine(routines, thread.threadId, { idempotencyKey: "routine-run:off-2" })).toMatchObject({ allowed: false, reason: "PREVIOUS_RUN_ACTIVE" });
    expect(hasOpenTurns(host)).toBe(true);
    host.clock.now += BROWSER_CLAIM_WAIT_MS + 1;
    await recover(host);
    await host.settle();
    const turn = one<{ turn_id: string }>(host.storage, "SELECT turn_id FROM agent_turns WHERE thread_id = ?", first.allowed ? first.thread.threadId : "")!;
    expect(getTurn(host, turn.turn_id)).toMatchObject({ status: "failed", errorCode: "CHROME_OFFLINE" });
    host.respond([answer("Back.")]);
    expect(await runRoutine(routines, thread.threadId, { idempotencyKey: "routine-run:off-3" })).toMatchObject({ allowed: true, created: true });
    await host.settle();
  });

  it("an edit re-derives the clock, a replayed key answers the first time, and delete archives the Routine with its runs", async () => {
    const { host, alarms, routines } = fixture();
    const request = save();
    const { thread } = await createRoutine(routines, request);
    expect((await createRoutine(routines, request)).thread.threadId).toBe(thread.threadId);
    await expect(createRoutine(routines, { ...request, title: "Other" })).rejects.toThrow("IDEMPOTENCY_CONFLICT");
    const paused = await updateRoutine(routines, thread.threadId, save({ enabled: false }));
    expect(paused.thread.schedule).toMatchObject({ enabled: false, nextAt: null });
    expect(alarmJobs(alarms)).toHaveLength(0);
    host.respond([answer("ok")]);
    const run = await runRoutine(routines, thread.threadId, { idempotencyKey: "routine-run:del-1" });
    await host.settle();
    expect((await deleteRoutine(routines, thread.threadId)).status).toBe("archived");
    expect(listRoutines(routines).items).toEqual([]);
    expect(one<{ status: string }>(host.storage, "SELECT status FROM agent_threads WHERE thread_id = ?", run.allowed ? run.thread.threadId : "")?.status).toBe("archived");
    expect(listThreads(host).threads).toEqual([]);
  });

  it("an account from before Routines keeps its threads", () => {
    const storage = sqliteStorage();
    storage.sql.exec(`CREATE TABLE agent_threads (thread_id TEXT PRIMARY KEY, account_id TEXT NOT NULL,
      status TEXT NOT NULL CHECK (status IN ('active', 'archived')), created_at TEXT NOT NULL, updated_at TEXT NOT NULL, archived_at TEXT)`);
    storage.sql.exec("INSERT INTO agent_threads VALUES ('t_old', 'acct', 'archived', 'x', 'x', 'x')");
    migrate(storage);
    migrate(storage);
    expect(rows(storage, "SELECT thread_id, kind, status, schedule_json FROM agent_threads")).toEqual([{ thread_id: "t_old", kind: "chat", status: "archived", schedule_json: null }]);
    const host = testHost({ storage });
    host.respond([answer("hi")]);
    expect(submitMessage(host, { threadId: "t_new", text: "hello", context: null, idempotencyKey: "key-old-account-1" }).turnId).toMatch(/^turn_/);
    expect(one(storage, "SELECT kind, status FROM agent_threads WHERE thread_id = ?", "t_new")).toEqual({ kind: "chat", status: "active" });
  });
});

describe("Routine endpoints", async () => {
  // The Worker's edge, typed by the Worker's own tsconfig (this one has no Workers types).
  const edge = "../src/worker/index.ts";
  const { default: worker } = await import(/* @vite-ignore */ edge) as { default: { fetch(request: Request, env: never): Promise<Response> } };
  const calls: [string, ...unknown[]][] = [];
  const stub = new Proxy({ authenticate: async () => true }, {
    get: (target, name: string) => name === "then" ? undefined : name in target ? (target as Record<string, unknown>)[name] : async (...args: unknown[]) => { calls.push([name, ...args]); return { ok: name }; },
  });
  const env = { ACCOUNTS: { getByName: () => stub } } as never;
  const token = `acct_${"a".repeat(32)}.secret`;
  const send = (method: string, path: string, body?: unknown) => worker.fetch(new Request(`https://worker.test${path}`,
    { method, headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) }), env);
  const id = `routine_${"b".repeat(32)}`;

  it("route list, create, read, update, delete and run to the account, each body checked first", async () => {
    const body = save();
    expect((await send("GET", "/api/routines")).status).toBe(200);
    expect((await send("POST", "/api/routines", body)).status).toBe(201);
    expect((await send("GET", `/api/routines/${id}`)).status).toBe(200);
    expect((await send("PUT", `/api/routines/${id}`, body)).status).toBe(200);
    expect((await send("DELETE", `/api/routines/${id}`)).status).toBe(200);
    expect((await send("POST", `/api/routines/${id}/runs`, { idempotencyKey: "routine-run:route-1", permissions: { update: false, write: true } })).status).toBe(200);
    expect(calls.map(([name]) => name)).toEqual(["listRoutines", "createRoutine", "getRoutine", "updateRoutine", "deleteRoutine", "runRoutine"]);
    expect(calls[1][1]).toMatchObject({ title: "Morning tabs", enabled: true });
    expect(calls[5]).toEqual(["runRoutine", id, { idempotencyKey: "routine-run:route-1", permissions: { update: false, write: true } }]);
  });

  it("refuse a bad body with its code and reach nothing", async () => {
    calls.length = 0;
    const response = await send("POST", "/api/routines", save({ schedule: { ...EVERY_DAY, days: [] } }));
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: "ROUTINE_SCHEDULE_INVALID" });
    expect((await send("POST", `/api/routines/${id}/runs`, {})).status).toBe(400);
    expect((await send("GET", "/api/routines/routine_x")).status).toBe(404);
    expect(calls).toEqual([]);
  });
});
