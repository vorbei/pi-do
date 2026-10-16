// pi-do's Routines on agent-core's Routine engine (agent-core/routine, shared with X Gardener): this
// file is configuration and composition only. It binds the RoutineHost (its one account, the core's
// alarm jobs on this object's alarm, its log, idempotency records, a run's first turn through
// turns.ts, read-only by default) and the AlarmHost, and gives the panel its view of a Routine.
import * as core from "agent-core/routine";
import type { AlarmHost, RoutineHost, ThreadRow } from "agent-core/routine";
import { sha256 } from "agent-core/runtime";
import type { RoutineDetailView, RoutineListView, RoutinePermissions, RoutineRunResult, RoutineSaveRequest, RoutineThreadView, TurnStatus } from "../shared/protocol.ts";
import { one, run } from "./schema.ts";
import { prepareRunTurn, queueRunTurn, startQueuedTurns, type PreparedRunTurn, type TurnHost } from "./turns.ts";

/** A Routine's runs only read unless the user allows acting in the browser. */
const READ_ONLY: RoutinePermissions = { update: false, write: false };
const TERMINAL_SQL = `('completed','failed','cancelled')`;

/** The object's alarm as agent-core's job queue: Routine jobs only (turn recovery runs on every wake). */
export function alarmHost(storage: AlarmHost["storage"], { log, nextDeadline, routines }: {
  log(event: string, detail: Record<string, unknown>): void; nextDeadline(): number | undefined; routines(): RoutineHost;
}): AlarmHost {
  return {
    storage,
    callbacks: [core.ROUTINE_ALARM],
    invoke: (_callback, payload) => core.runRoutineAlarm(routines(), payload),
    recover: async () => {},
    log,
    nextDeadline,
  };
}

/** pi-do's RoutineHost over its turns and the object's alarm. */
export function routineHost(turns: TurnHost, alarms: AlarmHost): RoutineHost<RoutineThreadView, PreparedRunTurn, string> {
  const storage = turns.storage;
  return {
    storage,
    account: () => {
      const row = one<{ account_id: string }>(storage, "SELECT account_id FROM account");
      return row ? { accountId: row.account_id, active: true } : null;
    },
    jobs: {
      schedule: (when, callback, payload, options) => core.addAlarmJob(alarms, when, callback, payload, options),
      list: () => core.alarmJobs(alarms),
      cancel: id => core.cancelAlarmJob(alarms, id),
    },
    ledger: (type, payload) => turns.log(type, payload),
    log: (event, detail) => turns.log(event, detail),
    idempotent: {
      async run(name, input, work) {
        const recorded = await replay(storage, name, input);
        if (recorded !== null) return recorded;
        return record(storage, name, input, await work());
      },
      replay: (name, input) => replay(storage, name, input),
      record: (name, input, result) => record(storage, name, input, result),
    },
    runs: {
      prepare: async input => prepareRunTurn(turns, input),
      queue: prepared => queueRunTurn(turns, prepared),
      finish: () => startQueuedTurns(turns),
      busy: routineId => one<{ thread_id: string }>(storage, `SELECT run.thread_id FROM agent_threads run
        WHERE run.parent_thread_id = ? AND run.status = 'active'
          AND EXISTS (SELECT 1 FROM agent_turns turn WHERE turn.thread_id = run.thread_id AND turn.status NOT IN ${TERMINAL_SQL})
        ORDER BY run.created_at DESC LIMIT 1`, routineId),
    },
    view: threadView,
    defaultPermissions: READ_ONLY,
  };
}

// ---------------------------------------------------------------- the panel's requests

export const listRoutines = (host: RoutineHost<RoutineThreadView>): RoutineListView => core.routineList(host, { limit: 50 }) as RoutineListView;

export const getRoutine = (host: RoutineHost<RoutineThreadView>, threadId: string): RoutineDetailView =>
  core.routineDetail(host, { threadId, limit: 20 }) as RoutineDetailView;

export async function createRoutine(host: RoutineHost<RoutineThreadView>, request: RoutineSaveRequest): Promise<RoutineDetailView> {
  return await core.addRoutine(host, request) as RoutineDetailView;
}

export async function updateRoutine(host: RoutineHost<RoutineThreadView>, threadId: string, request: RoutineSaveRequest): Promise<RoutineDetailView> {
  return await core.editRoutine(host, { threadId, ...request }) as RoutineDetailView;
}

/** Archives the Routine with its runs (their turns stay) and stops its alarm; a running run holds it (AGENT_THREAD_BUSY). */
export async function deleteRoutine(host: RoutineHost<RoutineThreadView>, threadId: string): Promise<RoutineThreadView> {
  return await core.deleteRoutine(host, { threadId }) as RoutineThreadView;
}

export async function runRoutine(host: RoutineHost<RoutineThreadView>, threadId: string, input: { idempotencyKey: string; permissions?: RoutinePermissions }): Promise<RoutineRunResult> {
  return await core.requestRoutineRun(host, { threadId, ...input }) as RoutineRunResult;
}

// ---------------------------------------------------------------- views and records

/** A Routine or run thread as the panel sees it. */
function threadView(row: ThreadRow): RoutineThreadView {
  const summary = String(row.latest_turn_answer ?? "").split("\n").map(line => line.trim()).find(Boolean)?.slice(0, 200);
  return {
    threadId: row.thread_id, title: row.title, status: row.status, permissions: JSON.parse(row.permissions_json) as RoutinePermissions,
    ...(row.schedule_json ? { schedule: JSON.parse(row.schedule_json), routinePrompt: row.routine_prompt ?? "" } : {}),
    ...(row.parent_thread_id ? { parentThreadId: row.parent_thread_id, trigger: row.trigger as RoutineThreadView["trigger"] } : {}),
    createdAt: row.created_at, updatedAt: row.updated_at,
    latestTurnStatus: (row.latest_turn_status ?? null) as TurnStatus | null, latestTurnUpdatedAt: row.latest_turn_updated_at ?? null,
    ...(summary ? { latestTurnSummary: summary } : {}),
  };
}

// A Routine change answered once per key; the same key with other input is IDEMPOTENCY_CONFLICT.
async function replay(storage: TurnHost["storage"], name: string, input: Record<string, unknown>): Promise<any> {
  const row = one<{ operation: string; payload_hash: string; response_json: string }>(storage,
    "SELECT operation, payload_hash, response_json FROM idempotency_records WHERE idempotency_key = ?", String(input.idempotencyKey));
  if (!row) return null;
  if (row.operation !== `routine:${name}` || row.payload_hash !== await sha256(JSON.stringify(input))) throw new Error("IDEMPOTENCY_CONFLICT");
  return JSON.parse(row.response_json);
}

async function record<T>(storage: TurnHost["storage"], name: string, input: Record<string, unknown>, result: T): Promise<T> {
  run(storage, "INSERT OR IGNORE INTO idempotency_records (idempotency_key, operation, payload_hash, response_json, created_at) VALUES (?, ?, ?, ?, ?)",
    String(input.idempotencyKey), `routine:${name}`, await sha256(JSON.stringify(input)), JSON.stringify(result), new Date().toISOString());
  return result;
}
