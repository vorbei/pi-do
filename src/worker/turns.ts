// pi-do's turns on agent-core's durable runtime (shared with X Gardener): this file is configuration
// and composition only. It binds pi-do's TurnHost (clock, alarm, limits, its browser tool and
// run_code as the extension's executor calls, memory tools under receipts) and the attempt's options (prompt, tab-context line,
// page guides, observation stubs, the tools-off last step, the answer-repair policy, partial text,
// the per-turn spend ceiling), maps the Worker's turn requests (a message, a Routine run's first
// turn) onto the core, and gives the panel its view of turns (agent-core's projection, progress
// from the step log) and threads.
import type { Message, Model, ToolResultMessage } from "@earendil-works/pi-ai";
import * as core from "agent-core/runtime";
import type { FunctionCallRow, TurnProgressItem } from "agent-core/runtime";
import {
  answerRepairPolicy, cancelTurn as cancelCoreTurn, checkpointMessages, executorWaitingResult, insertTurn, reportModelRequests,
  runTurnAttempt, streamedSummary, writeJournalResult, type AttemptContext, type AttemptSetup, type TurnDriverHost,
} from "agent-core/pi";
import { bundledPageGuide, confirmedInstructions, estimateContextTokens } from "agent-core/memory";
import {
  BROWSER_CALL_LEASE_MS, BROWSER_CLAIM_WAIT_MS, CONTEXT_COMPACTION, MODEL_CONCURRENCY, RECOVERY_INTERVAL_MS, TURN_BUDGET, modelProfile,
} from "../config.ts";
import {
  ACTING_ACTIONS, parseBrowserCall, parseBrowserResult, parseRunCode, parseRunCodeResult, RUN_CODE_TOOL, WEB_FETCH_TOOL, WEB_SEARCH_TOOL,
  type BrowserResult, type RunCodeResult, type ClaimedBrowserCall, type MemoryPermission, type RoutinePermissions, type RoutineTrigger, type TabContext, type ThreadView,
  type TurnImage, type TurnImageType,
  type TurnStatus, type TurnView,
} from "../shared/protocol.ts";
import { BROWSER_TOOL_DESCRIPTION, contextLine, OUTPUT_LIMIT_NOTICE, PENDING_ACTION_STEER } from "agent-core/guidance";
import { BROWSER_TOOL, BROWSER_TOOL_PARAMETERS, READING_ACTIONS } from "agent-core/browser-tool";
import { stubOldObservations } from "./context.ts";
import { PAGE_GUIDES } from "./page-guides.ts";
import {
  accountInstructionsBlock, ANSWER_CHECK_PREFIX, COMPACTION_SYSTEM_PROMPT, compactionRequest, FINAL_STEP_NOTICE,
  failedPagesStop, lengthRewriteRequest, pageGuideText, PLAIN_ANSWER_REQUEST, READ_ONLY_RUN_REFUSAL, SYSTEM_PROMPT,
} from "./prompt.ts";
import type { StreamFn } from "./model.ts";
import { memoryTools, type PiTool, type RecordChange } from "./memory-tools.ts";
import { runCodeText, runCodeTool } from "./code-tool.ts";
import { webTools, type WebHost } from "./web-tools.ts";
import { one, rows, run, type Storage } from "./schema.ts";

export type TurnLimits = { [K in keyof typeof TURN_BUDGET]: number };

/** What the runtime needs from its Durable Object. */
export interface TurnHost {
  storage: Storage;
  now(): number;
  /** Keeps background work alive (ctx.waitUntil). */
  background(task: Promise<unknown>): void;
  setAlarm(at: number): void;
  /** The model of turns without images. */
  model: Model<any>;
  /** The model of a turn whose message carries images (VISION_MODEL_NAME); `model` when unset. */
  visionModel?: Model<any>;
  streamFn: StreamFn;
  log(event: string, detail?: Record<string, unknown>): void;
  limits?: TurnLimits;
  /** Overrides the compaction thresholds (tests). */
  compaction?: { compactAtTokens: number; keepRecentTokens: number; summaryTimeoutMs?: number };
  /** Wakes a waiting claim when a turn starts waiting for a browser call (one per Durable Object instance). */
  browserCalls?: BrowserCallSignal;
  /** The web tools' search keys (and a fetch stand-in in tests); no web tools without it. */
  web?: WebHost;
}

export interface BrowserCallSignal { notify(): void; wait(ms: number): Promise<void>; }

/** A wake-up for claims waiting in this instance; `wait` resolves on the next call or after `ms`. */
export function browserCallSignal(): BrowserCallSignal {
  const waiters = new Set<() => void>();
  return {
    notify() { for (const wake of [...waiters]) wake(); },
    wait: ms => new Promise<void>(resolve => {
      const wake = () => { clearTimeout(timer); waiters.delete(wake); resolve(); };
      const timer = setTimeout(wake, ms);
      waiters.add(wake);
    }),
  };
}

/** The longest a claim waits for a call; below the extension's and the platform's request limits. */
export const MAX_CLAIM_WAIT_MS = 10_000;
/** The most turns one page of a thread's turn list holds. */
export const TURN_PAGE_SIZE = 50;

/** A row of agent-core's `agent_turns`. */
interface TurnRow {
  turn_id: string; account_id: string; thread_id: string; session_id: string; status: TurnStatus; phase: string; input_json: string;
  final_answer: string | null; error_code: string | null; handoff_json: string | null; waiting_ref: string | null;
  created_at: string; updated_at: string; completed_at: string | null;
}
/** The request, and the steer mark agent-core's turn rows carry in `input_json`. */
interface TurnInput {
  text: string; context: TabContext | null; memory?: MemoryPermission; whileRunning?: "steer";
  /** A Routine run that may not act in the browser (its `write` is off): only reads. */
  readOnly?: true;
  /** The types of the images attached to the message, in order; their bytes are in `turn_images`. */
  images?: { mimeType: TurnImageType }[];
  /** The turn whose run absorbed this steer. */
  mergedIntoTurnId?: string;
}
/**
 * Without a stated permission (a panel older than 0.1.5 sends none), a message allows no memory
 * update. The panel itself defaults its switch to on and always states it.
 */
const DEFAULT_MEMORY: MemoryPermission = { update: false };
const memoryOf = (input: TurnInput): MemoryPermission => input.memory ?? DEFAULT_MEMORY;

const TERMINAL_SQL = `('completed','failed','cancelled')`;
/** The text of a browser call that failed without the extension saying why. */
const CALL_ERROR_TEXT: Record<string, string> = {
  BROWSER_FUNCTION_TIMEOUT: "The extension did not report this read in time. Read again if you still need it.",
  EFFECT_UNKNOWN: "The extension did not report this call in time; its effect is unknown. Observe the page before acting again.",
  [core.EXECUTOR_OFFLINE]: "No extension picked up this call. The side panel may be closed; tell the user to open it and try again.",
  TURN_CANCELLED: "The user cancelled the turn; the extension may or may not have run this call.",
};
/** Browser actions that change nothing on a page: an expired claim of one may be handed out again. */
const READ_ACTIONS = new Set<string>(READING_ACTIONS);
/** Vision routing's text reads: the core's browser text reads and the server reads that take no page input. */
const SERVER_TEXT_READS = new Set<string>([WEB_FETCH_TOOL, WEB_SEARCH_TOOL, "search_memory"]);
const visionTextRead = (call: { name?: string }) => core.browserTextRead(call) || SERVER_TEXT_READS.has(call?.name ?? "");
const iso = (ms: number) => new Date(ms).toISOString();

// ---------------------------------------------------------------- the TurnHost

const drivers = new WeakMap<TurnHost, TurnDriverHost>();

/** pi-do's TurnHost for agent-core's queue and driver: its clock, alarm, limits, browser results and attempt. */
function driverOf(host: TurnHost): TurnDriverHost {
  const cached = drivers.get(host);
  if (cached) return cached;
  const limits = host.limits ?? TURN_BUDGET;
  const driver: TurnDriverHost = {
    get storage() { return host.storage; },
    now: () => host.now(),
    log: (event, detail) => host.log(event, detail),
    // A turn that starts waiting for the browser wakes the extension's waiting claim.
    notify: topics => { if (topics.includes("work")) host.browserCalls?.notify(); },
    background: task => host.background(task),
    armWatchdog: async at => host.setAlarm(at ?? host.now() + RECOVERY_INTERVAL_MS),
    startAttempt: turnId => runTurnAttempt(driver, turnId),
    modelConcurrency: () => MODEL_CONCURRENCY,
    // A running turn's lease covers the slower of the two models' request timeouts.
    modelDeadlineMs: () => Math.max(modelProfile(host.model.id).timeoutMs, modelProfile((host.visionModel ?? host.model).id).timeoutMs),
    maxAttempts: limits.attempts,
    executorClaimWaitMs: BROWSER_CLAIM_WAIT_MS,
    executorLeaseMs: BROWSER_CALL_LEASE_MS,
    calls: {
      // A browser read and a code run may be handed out (and replayed) again; any other action, and a memory change, runs once.
      readOnly: (name, input) => name === BROWSER_TOOL ? READ_ACTIONS.has((input as { action?: string })?.action ?? "") : name === "search_memory" || name === RUN_CODE_TOOL,
      executor: name => name === BROWSER_TOOL || name === RUN_CODE_TOOL,
      settled: (messages, call) => replaceResult(messages as Message[], call.tool_call_id,
        outcomeMessage(call, JSON.parse(call.result_json ?? "null"), call.error_code)),
      error: ({ error }) => ({ content: [{ type: "text", text: `${error.code}: ${error.message}` }], details: { errorCode: error.code } }),
    },
    // The settled result replaces the call's waiting result in the turn's journal (agent-core's write).
    writeResult: (call, turn, { result, errorCode }) => writeJournalResult(host.storage, turn, checkpoint => {
      const stored = errorCode || call.function_name !== BROWSER_TOOL ? result : withPageGuide(host, call.turn_id, result as BrowserResult);
      return { result: stored, messages: replaceResult(checkpointMessages(checkpoint) as Message[], call.tool_call_id, outcomeMessage(call, stored, errorCode)) };
    }),
    attempt: { prepare: context => prepareAttempt(host, driver, limits, context) },
  };
  drivers.set(host, driver);
  return driver;
}

// ---------------------------------------------------------------- requests

/**
 * Queues a message as a turn of its thread (a message sent while the thread's turn runs steers it).
 * Codes as X Gardener's. A message with images (validated by protocol.ts) may have no text; its turn
 * runs on the vision model. When that model cannot read images (a host without one, whose model
 * cannot) it is refused (MODEL_IMAGE_INPUT_UNSUPPORTED), never sent without them.
 */
export function submitMessage(host: TurnHost, input: { threadId: string; text: string; context: TabContext | null; idempotencyKey: string; memory?: MemoryPermission; images?: TurnImage[] }): TurnView {
  const images = input.images ?? [];
  if (!/^[A-Za-z0-9_-]{1,80}$/.test(input.threadId) || (!input.text.trim() && !images.length) || input.text.length > 20_000) throw new Error("INVALID_TURN_INPUT");
  if (!/^[A-Za-z0-9_-]{8,128}$/.test(input.idempotencyKey)) throw new Error("INVALID_IDEMPOTENCY_KEY");
  if (images.length && !(host.visionModel ?? host.model).input.includes("image")) throw new Error("MODEL_IMAGE_INPUT_UNSUPPORTED");
  // The request's canonical form; a replay must match it (images by type, length and checksum).
  const inputHash = JSON.stringify(images.length ? [input.threadId, input.text, images.map(image => [image.mimeType, image.data.length, checksum(image.data)])]
    : [input.threadId, input.text]);
  const existing = one<{ turn_id: string; input_hash: string }>(host.storage, "SELECT turn_id, input_hash FROM agent_turns WHERE idempotency_key = ?", input.idempotencyKey);
  if (existing) {
    if (existing.input_hash !== inputHash) throw new Error("IDEMPOTENCY_CONFLICT");
    return getTurn(host, existing.turn_id)!;
  }
  const account = one<{ account_id: string }>(host.storage, "SELECT account_id FROM account");
  if (!account) throw new Error("ACCOUNT_NOT_BOOTSTRAPPED");
  if (one(host.storage, "SELECT 1 FROM agent_threads WHERE thread_id = ? AND status = 'archived'", input.threadId)) throw new Error("AGENT_THREAD_NOT_ACTIVE");
  const turnId = core.createId("turn");
  const memory = input.memory ?? DEFAULT_MEMORY;
  const driver = driverOf(host);
  const now = iso(host.now());
  host.storage.transactionSync(() => {
    run(host.storage, `INSERT INTO agent_threads (thread_id, account_id, kind, status, context_policy, created_at, updated_at)
      VALUES (?, ?, 'chat', 'active', 'continuous', ?, ?) ON CONFLICT (thread_id) DO NOTHING`, input.threadId, account.account_id, now, now);
    images.forEach((image, position) => run(host.storage, "INSERT INTO turn_images (turn_id, position, mime_type, data) VALUES (?, ?, ?, ?)",
      turnId, position, image.mimeType, image.data));
    insertTurn(driver, { turnId, accountId: account.account_id, threadId: input.threadId, runtimeVersion: "pi-do",
      permissions: { update: memory.update, write: false }, idempotencyKey: input.idempotencyKey, inputHash, now,
      input: { text: input.text, context: input.context, memory, whileRunning: "steer",
        ...(images.length ? { images: images.map(({ mimeType }) => ({ mimeType })) } : {}) } satisfies TurnInput });
  });
  host.log("agent.turn.queued", { accountId: account.account_id, threadId: input.threadId, turnId });
  core.scheduleTurns(driver);
  host.setAlarm(host.now() + RECOVERY_INTERVAL_MS);
  return getTurn(host, turnId)!;
}

/** A Routine run's first turn, before its thread exists: the same key with other text is IDEMPOTENCY_CONFLICT. */
export interface PreparedRunTurn { threadId: string; text: string; idempotencyKey: string; inputHash: string; existingTurnId: string | null; }

export function prepareRunTurn(host: TurnHost, { threadId, input, idempotencyKey }: { threadId: string; input: string; idempotencyKey: string }): PreparedRunTurn {
  const inputHash = JSON.stringify([threadId, input]);
  const existing = one<{ turn_id: string; input_hash: string }>(host.storage, "SELECT turn_id, input_hash FROM agent_turns WHERE idempotency_key = ?", idempotencyKey);
  if (existing && existing.input_hash !== inputHash) throw new Error("IDEMPOTENCY_CONFLICT");
  return { threadId, text: input, idempotencyKey, inputHash, existingTurnId: existing?.turn_id ?? null };
}

/**
 * Queues a run's first turn in its (just created) thread, inside the fire's transaction: the
 * Routine's prompt with no tab, the memory permission of the run, and read-only unless the run may act.
 */
export function queueRunTurn(host: TurnHost, prepared: PreparedRunTurn): string {
  if (prepared.existingTurnId) return prepared.existingTurnId;
  const thread = one<{ account_id: string; permissions_json: string; trigger: string | null }>(host.storage,
    "SELECT account_id, permissions_json, trigger FROM agent_threads WHERE thread_id = ?", prepared.threadId)!;
  const permissions: RoutinePermissions & Record<string, unknown> = JSON.parse(thread.permissions_json);
  const turnId = core.createId("turn");
  insertTurn(driverOf(host), { turnId, accountId: thread.account_id, threadId: prepared.threadId, runtimeVersion: "pi-do", permissions,
    idempotencyKey: prepared.idempotencyKey, inputHash: prepared.inputHash, now: iso(host.now()),
    input: { text: prepared.text, context: null, memory: { update: permissions.update }, ...(permissions.write ? {} : { readOnly: true }), whileRunning: "steer" } satisfies TurnInput });
  // A scheduled run with no side panel to reach is recorded as browser-offline at once: no model
  // call is made for a run that could not use the browser. Nothing retries it later.
  if (thread.trigger === "schedule" && !browserOnline(host)) {
    const now = iso(host.now());
    run(host.storage, `UPDATE agent_turns SET status = 'failed', phase = 'done', error_code = ?, updated_at = ?, completed_at = ? WHERE turn_id = ?`,
      core.EXECUTOR_OFFLINE, now, now, turnId);
    host.log("agent.turn.browser_unavailable", { accountId: thread.account_id, threadId: prepared.threadId, turnId, errorCode: core.EXECUTOR_OFFLINE });
    return turnId;
  }
  host.log("agent.turn.queued", { accountId: thread.account_id, threadId: prepared.threadId, turnId });
  return turnId;
}

/** Whether a side panel claimed browser calls within the claim wait (a panel with a Routine on a schedule looks once a minute). */
export function browserOnline(host: TurnHost): boolean {
  const seen = one<{ last_claim_at: number | null }>(host.storage, "SELECT last_claim_at FROM account")?.last_claim_at;
  return seen != null && host.now() - seen < BROWSER_CLAIM_WAIT_MS;
}

/** After a run's turn is committed: start it. */
export function startQueuedTurns(host: TurnHost): void {
  core.scheduleTurns(driverOf(host));
  host.setAlarm(host.now() + RECOVERY_INTERVAL_MS);
}

/** Whether any turn is not terminal (the alarm keeps its recovery cadence while one is). */
export function hasOpenTurns(host: TurnHost): boolean {
  return (one<{ n: number }>(host.storage, `SELECT COUNT(*) AS n FROM agent_turns WHERE status NOT IN ${TERMINAL_SQL}`)?.n ?? 0) > 0;
}

export function getTurn(host: TurnHost, turnId: string): TurnView | null {
  const row = one<TurnRow>(host.storage, "SELECT * FROM agent_turns WHERE turn_id = ?", turnId);
  return row ? view(host, row) : null;
}

/** One page of a thread's turns, oldest first (agent-core's turn page); `nextBefore` pages back. */
export function listTurns(host: TurnHost, threadId: string, { before = null, limit = TURN_PAGE_SIZE }: { before?: string | null; limit?: number } = {}):
  { turns: TurnView[]; nextBefore: string | null } {
  const page = core.turnPage(driverOf(host), { threadId, before, limit: Math.max(1, Math.min(TURN_PAGE_SIZE, Math.trunc(limit) || TURN_PAGE_SIZE)) });
  return { turns: page.rows.map(row => view(host, row as unknown as TurnRow)), nextBefore: page.nextBefore };
}

/** Cancels a turn with its open browser calls (agent-core's cancel); the thread's next turn reads why each call ended. */
export function cancelTurn(host: TurnHost, turnId: string): TurnView {
  cancelCoreTurn(driverOf(host), turnId, iso(host.now()));
  return getTurn(host, turnId)!;
}

/** The user retries the thread's latest turn that failed or was cancelled, with another turn budget (agent-core's retry). */
export function retryTurn(host: TurnHost, turnId: string, idempotencyKey: string): TurnView {
  const limits = host.limits ?? TURN_BUDGET;
  core.queueTurnRetry(driverOf(host), turnId, idempotencyKey, { turnBudget: { modelCalls: limits.modelCalls, toolCalls: limits.toolCalls } });
  host.setAlarm(host.now() + RECOVERY_INTERVAL_MS);
  return getTurn(host, turnId)!;
}

/** The extension takes the oldest executor call (a browser action or a code run) of a suspended turn. */
export function claimBrowserCall(host: TurnHost): { call: ClaimedBrowserCall | null; activeTurns: number } {
  // Each claim is the side panel saying it is open: a scheduled Routine run reads it (browserOnline).
  run(host.storage, "UPDATE account SET last_claim_at = ?", host.now());
  const claimed = core.claimFunctionCall(driverOf(host), {});
  const activeTurns = one<{ n: number }>(host.storage, `SELECT COUNT(*) AS n FROM agent_turns WHERE status NOT IN ${TERMINAL_SQL}`)?.n ?? 0;
  if (!claimed?.callId) return { call: null, activeTurns };
  const lease = { callId: claimed.callId, leaseId: claimed.leaseId, turnId: claimed.turnId, threadId: claimed.threadId! };
  return { call: claimed.functionName === RUN_CODE_TOOL ? { ...lease, tool: "run_code", call: parseRunCode(claimed.input) }
    : { ...lease, tool: "browser", call: parseBrowserCall(claimed.input) }, activeTurns };
}

/**
 * A claim that, while a turn is active and no call is ready, waits up to `waitMs` for the model
 * to create one: the extension gets a call as soon as it exists instead of on its next poll.
 */
export async function claimBrowserCallWaiting(host: TurnHost, waitMs: number): Promise<{ call: ClaimedBrowserCall | null; activeTurns: number }> {
  const first = claimBrowserCall(host);
  if (first.call || !first.activeTurns || waitMs <= 0 || !host.browserCalls) return first;
  await host.browserCalls.wait(Math.min(waitMs, MAX_CLAIM_WAIT_MS));
  return claimBrowserCall(host);
}

/**
 * The extension's outcome of a claimed call, accepted once (agent-core's function-result receipt:
 * the same delivery again is acknowledged, a different one is FUNCTION_RESULT_CONFLICT, an unknown
 * call or a stale lease FUNCTION_CALL_LEASE_INVALID). A result for a call the user cancelled
 * meanwhile is dropped.
 */
export async function completeBrowserCall(host: TurnHost, input: { callId: string; leaseId: string; result?: unknown; errorCode?: string; message?: string }): Promise<{ accepted: boolean }> {
  const call = one<Pick<FunctionCallRow, "status" | "error_code" | "function_name">>(host.storage,
    "SELECT status, error_code, function_name FROM agent_function_calls WHERE call_id = ?", input.callId);
  if (call?.status === "failed" && call.error_code === "TURN_CANCELLED") return { accepted: false };
  const result = input.errorCode ? { message: String(input.message || input.errorCode).slice(0, 2_000) }
    : call?.function_name === RUN_CODE_TOOL ? parseRunCodeResult(input.result) : parseBrowserResult(input.result);
  await core.completeFunctionCall(driverOf(host), { callId: input.callId, leaseId: input.leaseId, result, errorCode: input.errorCode ?? null });
  return { accepted: true };
}

/** Alarm handler: agent-core reclaims what an evicted or vanished executor left behind and reschedules. */
export async function recover(host: TurnHost): Promise<void> {
  await core.recoverTurns(driverOf(host));
  const pending = one<{ n: number }>(host.storage, `SELECT COUNT(*) AS n FROM agent_turns WHERE status NOT IN ${TERMINAL_SQL}`)?.n ?? 0;
  if (pending) host.setAlarm(host.now() + RECOVERY_INTERVAL_MS);
}

// ---------------------------------------------------------------- browser results in the journal

/** A browser result as stored: what the extension returned, plus the page guide shown with it. */
type StoredResult = BrowserResult & { guideId?: string };

/** The journal's result of a settled executor call: the page or the code run's output, or why the call failed. */
function outcomeMessage(call: Pick<FunctionCallRow, "call_id" | "tool_call_id" | "function_name">, result: unknown, errorCode: string | null): ToolResultMessage {
  if (call.function_name === RUN_CODE_TOOL) {
    const failed = (result as { message?: string } | null)?.message ?? CALL_ERROR_TEXT[errorCode ?? ""] ?? errorCode;
    const run = result as RunCodeResult;
    return { role: "toolResult", toolCallId: call.tool_call_id, toolName: RUN_CODE_TOOL, timestamp: Date.now(), details: { callId: call.call_id },
      isError: Boolean(errorCode) || !run.ok, content: [{ type: "text", text: errorCode ? `run_code failed (${errorCode}): ${failed}` : runCodeText(run) }] };
  }
  if (errorCode) {
    const text = (result as { message?: string } | null)?.message ?? CALL_ERROR_TEXT[errorCode] ?? errorCode;
    return { role: "toolResult", toolCallId: call.tool_call_id, toolName: BROWSER_TOOL, timestamp: Date.now(),
      content: [{ type: "text", text: `Browser error ${errorCode}: ${text}` }], details: { callId: call.call_id }, isError: true };
  }
  const stored = result as StoredResult;
  return { role: "toolResult", toolCallId: call.tool_call_id, toolName: BROWSER_TOOL, timestamp: Date.now(), details: { callId: call.call_id }, isError: false,
    content: [{ type: "text", text: stored.text + guideFor(stored) }, ...(stored.image ? [{ type: "image" as const, data: stored.image.data, mimeType: stored.image.mimeType }] : [])] };
}

/** The journal's waiting result of a call, replaced by its outcome. */
function replaceResult(messages: Message[], toolCallId: string, message: ToolResultMessage): Message[] {
  return messages.map(item => item.role === "toolResult" && item.toolCallId === toolCallId ? message : item);
}

/** Marks the result with the page guide of its page, unless this turn has already been shown that guide. */
function withPageGuide(host: TurnHost, turnId: string, result: BrowserResult): StoredResult {
  const guide = result.pageUrl ? bundledPageGuide(PAGE_GUIDES, result.pageUrl) : null;
  if (!guide) return result;
  const shown = rows<{ result_json: string }>(host.storage, "SELECT result_json FROM agent_function_calls WHERE turn_id = ? AND status = 'completed'", turnId)
    .some(row => (JSON.parse(row.result_json) as StoredResult).guideId === guide.id);
  return shown ? result : { ...result, guideId: guide.id };
}

function guideFor(result: StoredResult): string {
  if (!result.guideId || !result.pageUrl) return "";
  const guide = bundledPageGuide(PAGE_GUIDES, result.pageUrl);
  return guide?.id === result.guideId ? `\n\n${pageGuideText(guide)}` : "";
}

// ---------------------------------------------------------------- one attempt

/** pi-do's attempt: the browser and memory tools, its prompt and limits, the tab context and answer repairs. */
function prepareAttempt(host: TurnHost, driver: TurnDriverHost, limits: TurnLimits, { turn, input: raw, saved, receipt }: AttemptContext): AttemptSetup {
  const input = raw as TurnInput;
  const turnId = turn.turn_id;
  // One durable budget per turn (agent-core's), with pi-do's own spend ceiling counted in it.
  const budget = core.createTurnBudget(saved.budget ?? {}, { maxModelCalls: limits.modelCalls, maxToolCalls: limits.toolCalls, maxCostUsd: limits.costUsd,
    maxCodeExecCalls: limits.codeRuns });
  // A memory change runs under agent-core's tool receipt: once per tool-call id, never repeated after an interruption.
  const record: RecordChange = (name, toolCallId, params, change) => receipt(name, async () => change())(toolCallId, params) as ReturnType<RecordChange>;
  const tools: PiTool[] = [browserTool(driver, turnId, input.readOnly === true, limits.failedPages), ...memoryTools(host.storage, turnId, memoryOf(input), toolCallId => budget.reserve("tool", toolCallId).ok, record)];
  // A code run counts against the turn's code runs (and, as every tool call, its tool calls); a replayed call id counts once.
  tools.push(runCodeTool(driver, turnId, limits.codeRuns, toolCallId => budget.reserve("codeExec", toolCallId).ok));
  // Web reads run here in the Worker; a billed search's cost counts in the turn's spend ceiling.
  if (host.web) tools.push(...webTools(host.web, usd => budget.addCost(usd), (event, detail) => host.log(event, { turnId, ...detail })));
  // The last tool step goes without tools, keeping the answer-repair reserve.
  const finalStep = () => budget.remaining("model") <= limits.answerRepairs || !budget.spendAvailable();
  return {
    budget,
    tools,
    text: steer => `${contextLine((steer as TurnInput).context)}\n${(steer as TurnInput).text}`,
    // The message's images go to the model in its user message, as Pi image content.
    images: (message, messageTurnId) => (message as TurnInput).images?.length ? turnImages(host, messageTurnId)
      .map(image => ({ type: "image" as const, data: image.data, mimeType: image.mimeType })) : [],
    // A steer runs under this turn's memory permission, so one that states another permission
    // is not merged: it runs as its own turn, after this one.
    acceptsSteer: candidate => memoryOf(candidate.input).update === memoryOf(input).update
      && (candidate.input as TurnInput).readOnly === input.readOnly,
    open: async ({ modelEvent, messages }) => {
      // A turn whose own message carries images runs on the vision model; in the others, a request
      // answering a tool result with an image (a screenshot), or a vision-model step other than a text
      // read (a tap, a code run), runs on the vision model, the rest on the default one. A server
      // read with no page input (web search or fetch, memory search) is a text read too.
      const model = input.images?.length ? host.visionModel ?? host.model : host.model;
      const routed = core.routeVisionRequests({ text: { model, streamFn: host.streamFn }, textRead: visionTextRead, since: Date.parse(String(turn.created_at)),
        // A request whose input alone, uncached at the vision model's price, would pass what the turn's
        // spend ceiling leaves stays on the default model (one sol request on a long thread cost $0.46-0.91).
        affordable: (visionModel: Model<any>, context: any) => {
          const price = Math.max(modelProfile(visionModel.id).cost.input, modelProfile(visionModel.id).cost.cacheWrite);
          const tokens = estimateContextTokens([...(context?.messages ?? []), { role: "user", content: String(context?.systemPrompt ?? "") },
            { role: "user", content: JSON.stringify(context?.tools ?? []) }]);
          return (tokens * price) / 1_000_000 <= budget.remainingCostUsd();
        },
        vision: !input.images?.length && host.visionModel ? { model: host.visionModel, streamFn: host.streamFn } : null });
      const repairs = answerRepairPolicy({ userText: input.text, messages,
        wording: { prefix: ANSWER_CHECK_PREFIX, plain: PLAIN_ANSWER_REQUEST, length: lengthRewriteRequest },
        onRepair: kind => host.log("agent.output.answer_repair", { turnId, repair: kind }) });
      return { options: {
        model,
        streamFn: reportModelRequests((model: Model<any>, context: any, options: any) => routed(model, repairs.answering ? { ...context, tools: [] }
          : finalStep() ? { ...context, tools: [], systemPrompt: `${context.systemPrompt}\n\n${FINAL_STEP_NOTICE}` } : context, options), modelEvent),
        // The user's confirmed standing instructions, read at the start of each attempt.
        systemPrompt: SYSTEM_PROMPT + accountInstructionsBlock(confirmedInstructions(host.storage)),
        tools,
        maxSteps: limits.modelCalls,
        maxToolCalls: limits.toolCalls,
        contextSettings: host.compaction ?? CONTEXT_COMPACTION,
        summarizeContext: streamedSummary({ model, streamFn: host.streamFn, systemPrompt: COMPACTION_SYSTEM_PROMPT, request: compactionRequest,
          onCost: usd => budget.addCost(usd), now: host.now }),
        onCompact: detail => host.log("agent.context_compacted", { threadId: turn.thread_id, turnId, outcome: detail.outcome, reason: detail.reason,
          errorCode: detail.errorCode, tokensBefore: detail.tokensBefore, tokensAfter: detail.tokensAfter }),
        contextView: messages => stubOldObservations(messages as Message[]),
        // The answer so far is written by agent-core's turn driver (agent_turns.partial_text).
        onEvent: event => {
          if (event.type === "tool_execution_start") {
            core.appendTurnStep(driver, turnId, Number(turn.attempt ?? 0), "tool", "started", { toolName: event.toolName, toolCallId: event.toolCallId });
          }
          if (event.type === "tool_markup_stripped") host.log("agent.output.tool_markup_stripped", { turnId, keptOriginal: event.keptOriginal });
          if (event.type === "pending_action_steer") host.log("agent.output.pending_action_steer", { turnId });
        },
        outputPolicy: repairs,
        pendingActionWording: PENDING_ACTION_STEER,
        outputLimitWording: OUTPUT_LIMIT_NOTICE,
      } };
    },
  };
}

/** Browser calls that go to a page: after `failedPages` of them failed to load in a turn, the next one is refused. */
const PAGE_ACTIONS = new Set(["open", "navigate"]);
const LOAD_FAILURES = ["PAGE_LOAD_FAILED", "NAVIGATION_FAILED"];

/** agent-core's core browser tool (its action model, parameters and description), run by pi-do's executor. */
function browserTool(driver: TurnDriverHost, turnId: string, readOnly: boolean, failedPages: number): PiTool {
  return {
    name: BROWSER_TOOL,
    label: "Browser",
    description: BROWSER_TOOL_DESCRIPTION,
    parameters: BROWSER_TOOL_PARAMETERS as unknown as PiTool["parameters"],
    executionMode: "sequential",
    // The call is queued for the extension; the run stops at its waiting result and the turn
    // resumes when the extension settles it.
    async execute(toolCallId, params) {
      let call;
      try { call = parseBrowserCall(params); }
      catch (error) { throw new Error(`Invalid browser call: ${(error as Error).message}`); }
      // A Routine run without its `write` permission only reads; refused before anything is queued.
      if (readOnly && ACTING_ACTIONS.includes(call.action)) throw new Error(READ_ONLY_RUN_REFUSAL);
      if (PAGE_ACTIONS.has(call.action)) {
        const failed = one<{ n: number }>(driver.storage, `SELECT COUNT(*) AS n FROM agent_function_calls WHERE turn_id = ? AND function_name = ?
          AND status = 'failed' AND error_code IN (${LOAD_FAILURES.map(() => "?").join(", ")})`, turnId, BROWSER_TOOL, ...LOAD_FAILURES)!.n;
        if (failed >= failedPages) throw new Error(failedPagesStop(failed));
      }
      const accountId = one<{ account_id: string }>(driver.storage, "SELECT account_id FROM agent_turns WHERE turn_id = ?", turnId)!.account_id;
      const callId = core.insertFunctionCall(driver, { turnId, accountId, toolCallId, functionName: BROWSER_TOOL, input: call });
      return executorWaitingResult({ callId, functionName: BROWSER_TOOL }) as Awaited<ReturnType<PiTool["execute"]>>;
    },
  };
}

// ---------------------------------------------------------------- the panel's view of turns and threads

const PROGRESS_LABELS = { queued: "Waiting to run", working: "Working", done: "How it worked" };
const OPEN_CALL = new Set(["created", "claimed"]);

// The turn's progress items for agent-core's projection, from its step log: each tool the model
// ran (a browser call by its action), with the browser call's outcome.
function activityOf(host: TurnHost, turnId: string): TurnProgressItem[] {
  const steps = rows<{ step_index: number; tool_name: string | null; tool_call_id: string | null; created_at: string; status: string | null; error_code: string | null; input_json: string | null }>(host.storage,
    `SELECT steps.step_index, steps.tool_name, steps.tool_call_id, steps.created_at, calls.status, calls.error_code, calls.input_json FROM agent_turn_steps steps
     LEFT JOIN agent_function_calls calls ON calls.turn_id = steps.turn_id AND calls.tool_call_id = steps.tool_call_id
     WHERE steps.turn_id = ? AND steps.kind = 'tool' ORDER BY steps.step_index DESC LIMIT 24`, turnId);
  return steps.map(step => {
    const action = step.input_json ? String((JSON.parse(step.input_json) as { action?: string }).action ?? step.tool_name) : step.tool_name ?? "";
    const state = step.status === "failed" ? " · failed" : step.status && OPEN_CALL.has(step.status) ? " · running" : "";
    return { id: step.tool_call_id ?? String(step.step_index), label: `${action}${state}`, at: step.created_at,
      ...(step.tool_name ? { tool: step.tool_name } : {}), ...(step.error_code ? { errorCode: step.error_code } : {}) };
  });
}

/** A turn as the panel sees it: agent-core's projection (with the answer so far) and the user's text. */
function view(host: TurnHost, row: TurnRow): TurnView {
  const input = JSON.parse(row.input_json) as TurnInput;
  return {
    ...core.projectTurn(row, { fields: input.mergedIntoTurnId ? { mergedIntoTurnId: input.mergedIntoTurnId } : {},
      progress: core.turnProgress(activityOf(host, row.turn_id), row.status, PROGRESS_LABELS) }),
    status: row.status, input: input.text, parentTurnId: null,
    ...(input.images?.length ? { images: input.images.map(({ mimeType }) => ({ mimeType })) } : {}),
  };
}

/** The images attached to a turn's message, in order (none for a turn without images). */
export function turnImages(host: TurnHost, turnId: string): TurnImage[] {
  return rows<{ mime_type: TurnImageType; data: string }>(host.storage, "SELECT mime_type, data FROM turn_images WHERE turn_id = ? ORDER BY position", turnId)
    .map(row => ({ mimeType: row.mime_type, data: row.data }));
}

/** One image of a turn's message, for the panel to show (`GET /api/turns/<turnId>/images/<index>`); null when there is none. */
export function turnImage(host: TurnHost, turnId: string, position: number): TurnImage | null {
  const row = one<{ mime_type: TurnImageType; data: string }>(host.storage, "SELECT mime_type, data FROM turn_images WHERE turn_id = ? AND position = ?", turnId, position);
  return row ? { mimeType: row.mime_type, data: row.data } : null;
}

// FNV-1a over the base64 text: a replay with other image bytes of the same length is a conflict.
function checksum(text: string): string {
  let hash = 0x811c9dc5;
  for (let index = 0; index < text.length; index++) hash = Math.imul(hash ^ text.charCodeAt(index), 0x01000193);
  return (hash >>> 0).toString(16);
}

/** The most threads the panel's thread list holds. */
export const THREAD_PAGE_SIZE = 20;

/**
 * The account's threads, newest activity first, from their turns (a thread exists once it has a
 * message): titled by its first message, with its active turn's status, else its latest's.
 */
export function listThreads(host: TurnHost, { limit = THREAD_PAGE_SIZE }: { limit?: number } = {}): { threads: ThreadView[] } {
  const bounded = Math.max(1, Math.min(THREAD_PAGE_SIZE, Math.trunc(limit) || THREAD_PAGE_SIZE));
  const found = rows<{ thread_id: string; created_at: string; updated_at: string; first_input: string; latest_status: TurnStatus;
    title: string | null; parent_thread_id: string | null; trigger: RoutineTrigger | null }>(host.storage,
    `SELECT thread_id, MIN(created_at) AS created_at, MAX(updated_at) AS updated_at,
       (SELECT title FROM agent_threads thread WHERE thread.thread_id = turns.thread_id) AS title,
       (SELECT parent_thread_id FROM agent_threads thread WHERE thread.thread_id = turns.thread_id) AS parent_thread_id,
       (SELECT trigger FROM agent_threads thread WHERE thread.thread_id = turns.thread_id) AS trigger,
       (SELECT input_json FROM agent_turns first WHERE first.thread_id = turns.thread_id ORDER BY rowid LIMIT 1) AS first_input,
       COALESCE((SELECT status FROM agent_turns active WHERE active.thread_id = turns.thread_id AND status NOT IN ${TERMINAL_SQL} ORDER BY rowid DESC LIMIT 1),
         (SELECT status FROM agent_turns latest WHERE latest.thread_id = turns.thread_id ORDER BY rowid DESC LIMIT 1)) AS latest_status
     FROM agent_turns turns WHERE thread_id IS NOT NULL
       AND thread_id NOT IN (SELECT thread_id FROM agent_threads WHERE status = 'archived')
     GROUP BY thread_id ORDER BY MAX(rowid) DESC LIMIT ?`, bounded);
  return { threads: found.map(thread => ({
    threadId: thread.thread_id,
    title: thread.parent_thread_id && thread.title ? thread.title : (JSON.parse(thread.first_input) as TurnInput).text.replace(/\s+/g, " ").trim().slice(0, 60),
    createdAt: thread.created_at, updatedAt: thread.updated_at, latestTurnStatus: thread.latest_status, latestTurnUpdatedAt: thread.updated_at,
    ...(thread.parent_thread_id ? { parentThreadId: thread.parent_thread_id, ...(thread.trigger ? { trigger: thread.trigger } : {}) } : {}),
  })) };
}

/**
 * The user deletes a thread from the thread list. As in X Gardener, deletion archives it: the
 * thread leaves the list and takes no new message (AGENT_THREAD_NOT_ACTIVE), while its turns,
 * receipts and journal stay and nothing it did is undone. A thread with an unfinished turn is
 * AGENT_THREAD_BUSY (stop it first); a thread with no turn is AGENT_THREAD_NOT_FOUND.
 */
export function archiveThread(host: TurnHost, threadId: string): { threadId: string; status: "archived"; archivedAt: string } {
  return host.storage.transactionSync(() => {
    const account = one<{ account_id: string }>(host.storage, "SELECT account_id FROM account");
    if (!account) throw new Error("ACCOUNT_NOT_BOOTSTRAPPED");
    const thread = one<{ status: string; archived_at: string }>(host.storage, "SELECT status, archived_at FROM agent_threads WHERE thread_id = ?", threadId);
    if (thread?.status === "archived") return { threadId, status: "archived" as const, archivedAt: thread.archived_at };
    const turns = one<{ n: number; open: number }>(host.storage,
      `SELECT COUNT(*) AS n, COALESCE(SUM(status NOT IN ${TERMINAL_SQL}), 0) AS open FROM agent_turns WHERE thread_id = ?`, threadId)!;
    if (!turns.n) throw new Error("AGENT_THREAD_NOT_FOUND");
    if (turns.open) throw new Error("AGENT_THREAD_BUSY");
    const now = iso(host.now());
    run(host.storage, `INSERT INTO agent_threads (thread_id, account_id, kind, status, context_policy, created_at, updated_at, archived_at)
      VALUES (?, ?, 'chat', 'archived', 'continuous', ?, ?, ?)
      ON CONFLICT (thread_id) DO UPDATE SET status = 'archived', updated_at = excluded.updated_at, archived_at = excluded.archived_at`,
    threadId, account.account_id, now, now, now);
    host.log("agent.thread.archived", { accountId: account.account_id, threadId, outcome: "archived" });
    return { threadId, status: "archived" as const, archivedAt: now };
  });
}
