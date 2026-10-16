// A TurnHost backed by node:sqlite and Pi's scripted faux model, so the durable runtime runs
// unchanged outside workerd.
import { DatabaseSync } from "node:sqlite";
import type { StreamFn } from "../../src/worker/model.ts";
import { createFauxCore, type FauxResponseStep } from "@earendil-works/pi-ai";
import { claimTurn, durableToolExecute, type TurnHost as QueueHost } from "agent-core/runtime";
import { migrate, type Storage } from "../../src/worker/schema.ts";
import type { RecordChange } from "../../src/worker/memory-tools.ts";
import type { TurnHost } from "../../src/worker/turns.ts";

export function sqliteStorage(db = new DatabaseSync(":memory:")): Storage {
  let depth = 0;
  return {
    sql: { exec: (query: string, ...bindings: unknown[]) => {
      const values = db.prepare(query).all(...(bindings as never[]));
      return { toArray: () => values };
    } },
    transactionSync<T>(closure: () => T): T {
      const name = `sp${depth++}`;
      db.exec(`SAVEPOINT ${name}`);
      try { const value = closure(); db.exec(`RELEASE ${name}`); return value; }
      catch (error) { db.exec(`ROLLBACK TO ${name}`); db.exec(`RELEASE ${name}`); throw error; }
      finally { depth--; }
    },
  };
}

export interface TestHost extends TurnHost {
  clock: { now: number };
  tasks: Promise<unknown>[];
  alarms: number[];
  events: { event: string; detail?: Record<string, unknown> }[];
  respond(steps: FauxResponseStep[]): void;
  settle(): Promise<void>;
  requests: number;
}

/** Each response of `inner` as if the provider billed it `usd` (Pi's faux model reports no cost). */
function billed(inner: StreamFn, usd: number): StreamFn {
  const bill = (message: any) => message?.role === "assistant" ? { ...message, usage: { ...message.usage, cost: { ...message.usage.cost, total: usd } } } : message;
  return ((model: any, context: any, options: any) => {
    const stream = inner(model, context, options) as any;
    return { async *[Symbol.asyncIterator]() { for await (const event of stream) yield event.type === "done" ? { ...event, message: bill(event.message) } : event; },
      result: async () => bill(await stream.result()) };
  }) as unknown as StreamFn;
}

export function testHost(options: { storage?: Storage; streamFn?: StreamFn; limits?: TurnHost["limits"]; costUsd?: number } = {}): TestHost {
  const storage = options.storage ?? sqliteStorage();
  migrate(storage);
  storage.sql.exec("INSERT OR IGNORE INTO account (singleton, account_id, token_hash, created_at) VALUES (1, 'acct_test', 'hash', 0)");
  const faux = createFauxCore({ api: "faux", provider: "faux", models: [{ id: "faux-model", cost: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 } }] });
  const host: TestHost = {
    storage,
    clock: { now: 1_000_000 },
    tasks: [],
    alarms: [],
    events: [],
    requests: 0,
    now: () => host.clock.now,
    background: task => { host.tasks.push(task); },
    setAlarm: at => { host.alarms.push(at); },
    model: faux.models[0],
    streamFn: options.streamFn ?? billed((model, context, streamOptions) => { host.requests++; return faux.streamSimple(model, context, streamOptions); }, options.costUsd ?? 0),
    log: (event, detail) => { host.events.push({ event, detail }); },
    limits: options.limits,
    respond: steps => faux.setResponses(steps),
    async settle() {
      while (host.tasks.length) await host.tasks.shift();
    },
  };
  return host;
}

/**
 * A running turn of its own and the receipt-backed `record` the memory tools take, for calling
 * the tools directly as an attempt would.
 */
export function receiptRecorder(host: TestHost, turnId: string): RecordChange {
  const at = new Date(host.now()).toISOString();
  host.storage.sql.exec(`INSERT INTO agent_turns (turn_id, account_id, thread_id, session_id, runtime_version, status, phase,
    input_json, idempotency_key, input_hash, created_at, updated_at) VALUES (?, 'acct_test', ?, ?, 'pi-do', 'queued', 'queued', '{}', ?, '', ?, ?)`,
  turnId, `thread-${turnId}`, `thread-${turnId}`, `key-${turnId}`, at, at);
  const queue = { storage: host.storage, now: host.now, log: host.log, background: () => {}, armWatchdog: async () => {},
    startAttempt: async () => {}, modelConcurrency: () => 8, modelDeadlineMs: () => 90_000, maxAttempts: 9, executorClaimWaitMs: 60_000,
    writeResult: () => { throw new Error("no browser calls here"); } } satisfies QueueHost;
  const claim = claimTurn(queue, turnId)!;
  return (name, toolCallId, params, change) =>
    durableToolExecute(queue, turnId, claim, { name, execute: async () => change() })(toolCallId, params) as ReturnType<RecordChange>;
}

/**
 * An attempt lost after the model's last tool call reached the turn's journal and before its
 * results did: the turn's journal (agent-core's branch journal) ends at that call again.
 */
export function loseResultsAfterLastCall(host: TestHost, turnId: string): void {
  const [entry] = host.storage.sql.exec(`SELECT entry_id FROM pi_journal_entries WHERE entry_type = 'message'
    AND json_extract(entry_json, '$.message.role') = 'assistant' AND json_extract(entry_json, '$.message.stopReason') = 'toolUse'
    ORDER BY entry_seq DESC LIMIT 1`).toArray() as { entry_id: string }[];
  host.storage.sql.exec("UPDATE agent_turns SET checkpoint_json = json_set(checkpoint_json, '$.piSession.leafId', ?) WHERE turn_id = ?", entry.entry_id, turnId);
}
