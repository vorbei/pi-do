// One Durable Object per account: authentication, the RPC surface of the turn runtime and of
// Routines, and its one alarm (turn recovery, then the Routine jobs that are due).
import { DurableObject } from "cloudflare:workers";
import { nextAlarmTime, runAlarm, type AlarmHost } from "agent-core/routine";
import { RECOVERY_INTERVAL_MS } from "../config.ts";
import type { MemoryPermission, PdfTextRequest, RoutinePermissions, RoutineSaveRequest, TabContext, TurnImage } from "../shared/protocol.ts";
import { confirmByUser, forgetByUser, memoryView } from "./memory-view.ts";
import { sha256 } from "agent-core/runtime";
import { configuredModel, openRouterStream, visionModel, type ModelEnv } from "./model.ts";
import { migrate, one, run } from "./schema.ts";
import { pdfDeps, pdfText, type PdfEnv } from "./pdf.ts";
import { pdfCache } from "./pdf-cache.ts";
import * as routines from "./routines.ts";
import * as turns from "./turns.ts";

export interface Env extends ModelEnv, PdfEnv {
  ACCOUNTS: DurableObjectNamespace<AccountDO>;
  BOOTSTRAP_SECRET?: string;
  /** Optional search providers after OpenRouter's (OPTIONAL_SECRETS). */
  TAVILY_API_KEY?: string;
  BRAVE_API_KEY?: string;
}

export class AccountDO extends DurableObject<Env> {
  private readonly browserCalls = turns.browserCallSignal();
  // One alarm host for the object's life, so its alarm writes queue on one promise.
  private readonly alarms: AlarmHost;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    ctx.blockConcurrencyWhile(async () => migrate(ctx.storage));
    this.alarms = routines.alarmHost(ctx.storage as unknown as AlarmHost["storage"], {
      log: (event, detail) => console.log(JSON.stringify({ event, ...detail })),
      // While a turn is open the alarm also keeps the recovery cadence.
      nextDeadline: () => turns.hasOpenTurns(this.host()) ? Date.now() + RECOVERY_INTERVAL_MS : undefined,
      routines: () => this.routines(),
    });
  }

  private host(): turns.TurnHost {
    return {
      storage: this.ctx.storage,
      now: () => Date.now(),
      background: task => this.ctx.waitUntil(task),
      // Never later than the next Routine job, which the same alarm runs.
      setAlarm: at => { void this.ctx.storage.setAlarm(Math.min(at, nextAlarmTime(this.ctx.storage as unknown as AlarmHost["storage"]) ?? Infinity)); },
      model: configuredModel(this.env),
      visionModel: visionModel(this.env),
      streamFn: openRouterStream(this.env),
      log: (event, detail = {}) => console.log(JSON.stringify({ event, ...detail })),
      browserCalls: this.browserCalls,
      web: { keys: { OPENROUTER_API_KEY: this.env.OPENROUTER_API_KEY, TAVILY_API_KEY: this.env.TAVILY_API_KEY, BRAVE_API_KEY: this.env.BRAVE_API_KEY } },
    };
  }

  private routines() { return routines.routineHost(this.host(), this.alarms); }

  async bootstrap(accountId: string, token: string): Promise<void> {
    if (one(this.ctx.storage, "SELECT account_id FROM account")) throw new Error("ACCOUNT_EXISTS");
    run(this.ctx.storage, "INSERT INTO account (singleton, account_id, token_hash, created_at) VALUES (1, ?, ?, ?)",
      accountId, await sha256(token), Date.now());
  }

  async authenticate(token: string): Promise<boolean> {
    const account = one<{ token_hash: string }>(this.ctx.storage, "SELECT token_hash FROM account");
    return Boolean(account) && account!.token_hash === await sha256(token);
  }

  submitMessage(input: { threadId: string; text: string; context: TabContext | null; idempotencyKey: string; memory?: MemoryPermission; images?: TurnImage[] }) {
    return turns.submitMessage(this.host(), input);
  }

  /** One image the user attached to a turn's message, or null. */
  turnImage(turnId: string, position: number) { return turns.turnImage(this.host(), turnId, position); }

  listThreads(limit?: number) { return turns.listThreads(this.host(), { limit }); }

  /** The user deletes a thread: it is archived (its turns and receipts stay). */
  deleteThread(threadId: string) { return turns.archiveThread(this.host(), threadId); }

  listTurns(threadId: string, page: { before?: string | null; limit?: number } = {}) { return turns.listTurns(this.host(), threadId, page); }

  cancelTurn(turnId: string) { return turns.cancelTurn(this.host(), turnId); }

  retryTurn(turnId: string, idempotencyKey: string) { return turns.retryTurn(this.host(), turnId, idempotencyKey); }

  claimBrowserCall(waitMs = 0) { return turns.claimBrowserCallWaiting(this.host(), waitMs); }

  completeBrowserCall(input: { callId: string; leaseId: string; result?: unknown; errorCode?: string; message?: string }) {
    return turns.completeBrowserCall(this.host(), input);
  }

  /** The user's Memory view: standing instructions, and saved facts and events. */
  listMemory() { return memoryView(this.ctx.storage); }

  confirmMemory(memoryId: string) { return confirmByUser(this.ctx.storage, memoryId); }

  /** The user removes a memory from the side panel. */
  forgetMemory(memoryId: string) { return forgetByUser(this.ctx.storage, memoryId); }

  /** The PDF a tab shows, by its URL: from this account's conversion cache, else fetched and converted. */
  readPdfText(request: PdfTextRequest) {
    return pdfText(request, { ...pdfDeps(this.env), cache: pdfCache(this.ctx.storage, () => Date.now()) });
  }

  listRoutines() { return routines.listRoutines(this.routines()); }

  getRoutine(threadId: string) { return routines.getRoutine(this.routines(), threadId); }

  createRoutine(request: RoutineSaveRequest) { return routines.createRoutine(this.routines(), request); }

  updateRoutine(threadId: string, request: RoutineSaveRequest) { return routines.updateRoutine(this.routines(), threadId, request); }

  deleteRoutine(threadId: string) { return routines.deleteRoutine(this.routines(), threadId); }

  runRoutine(threadId: string, input: { idempotencyKey: string; permissions?: RoutinePermissions }) { return routines.runRoutine(this.routines(), threadId, input); }

  async alarm(): Promise<void> {
    await turns.recover(this.host());
    await runAlarm(this.alarms);
  }
}
