// The extension's Worker client and its stored settings. The account token is the only
// credential that leaves the browser, and it is this extension's own, never a site's.
import type {
  BrowserResult, ClaimedBrowserCall, MemoryPermission, MemoryView, PdfTextRequest, PdfTextResponse, RoutineDetailView, RoutineListView, RoutinePermissions,
  RoutineRunResult, RoutineSaveRequest, RoutineThreadView, RunCodeResult, TabContext, ThreadView, TurnImage, TurnView,
} from "../shared/protocol.ts";

/**
 * `threadId` is the thread the chat shows; `memoryUpdate` unset means on (the default), and every
 * message states it to the Worker. `workWindow` is where the agent opens tabs: its own window
 * (unset, the default) or the panel's window; it stays in the extension.
 */
export interface Settings { workerUrl: string; token: string; threadId?: string; memoryUpdate?: boolean; workWindow?: WorkWindow; }
export type WorkWindow = "own" | "this";

export async function loadSettings(): Promise<Partial<Settings>> {
  return chrome.storage.local.get(["workerUrl", "token", "threadId", "memoryUpdate", "workWindow"]) as Promise<Partial<Settings>>;
}
export async function saveSettings(values: Partial<Settings>): Promise<void> { await chrome.storage.local.set(values); }
export async function clearAccount(): Promise<void> { await chrome.storage.local.remove(["token"]); }

export class ApiError extends Error {
  constructor(public code: string, public status: number) { super(code); }
}

/** https only, except a local development Worker. */
export function normalizeWorkerUrl(value: string): string {
  const url = new URL(value.trim());
  const local = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
  if (url.protocol !== "https:" && !(local && url.protocol === "http:")) throw new ApiError("WORKER_URL_INVALID", 0);
  return url.origin;
}

async function call<T>(workerUrl: string, path: string, init: { method?: string; token?: string; body?: unknown } = {}): Promise<T> {
  let response: Response;
  try {
    response = await fetch(`${workerUrl}${path}`, {
      method: init.method ?? (init.body === undefined ? "GET" : "POST"),
      headers: { "Content-Type": "application/json", ...(init.token ? { Authorization: `Bearer ${init.token}` } : {}) },
      body: init.body === undefined ? undefined : JSON.stringify(init.body),
    });
  } catch { throw new ApiError("NETWORK_ERROR", 0); }
  const payload = await response.json().catch(() => ({})) as { error?: string };
  if (!response.ok) throw new ApiError(payload.error ?? `HTTP_${response.status}`, response.status);
  return payload as T;
}

export const bootstrap = (workerUrl: string, bootstrapSecret: string) =>
  call<{ accountId: string; token: string }>(workerUrl, "/api/bootstrap", { body: { bootstrapSecret } });

export const sendMessage = (s: Settings, input: { threadId: string; text: string; context: TabContext | null; idempotencyKey: string; images?: TurnImage[] }) =>
  call<{ turn: TurnView }>(s.workerUrl, "/api/turns", { token: s.token,
    body: { ...input, memory: { update: s.memoryUpdate !== false } satisfies MemoryPermission } });

/** One image the user attached to a turn's message, as a Blob to show. */
export async function fetchTurnImage(s: Settings, turnId: string, index: number): Promise<Blob> {
  let response: Response;
  try { response = await fetch(`${s.workerUrl}/api/turns/${turnId}/images/${index}`, { headers: { Authorization: `Bearer ${s.token}` } }); }
  catch { throw new ApiError("NETWORK_ERROR", 0); }
  if (!response.ok) throw new ApiError(((await response.json().catch(() => ({}))) as { error?: string }).error ?? `HTTP_${response.status}`, response.status);
  return response.blob();
}

export const listMemory = (s: Settings) => call<MemoryView>(s.workerUrl, "/api/memory", { token: s.token });

export const changeMemory = (s: Settings, memoryId: string, change: "confirm" | "forget") =>
  call<unknown>(s.workerUrl, `/api/memory/${memoryId}/${change}`, { token: s.token, body: {} });

export const listThreads = (s: Settings, limit: number) =>
  call<{ threads: ThreadView[] }>(s.workerUrl, `/api/threads?limit=${limit}`, { token: s.token });

/** Archives a thread: it leaves the list, its turns stay. */
export const deleteThread = (s: Settings, threadId: string) =>
  call<{ thread: { threadId: string; status: "archived"; archivedAt: string } }>(s.workerUrl, `/api/threads/${threadId}`, { method: "DELETE", token: s.token });

/** One page of a thread's turns, oldest first; `nextBefore` is the `before` of the page above it. */
export const listTurns = (s: Settings, threadId: string, page: { limit: number; before?: string }) =>
  call<{ turns: TurnView[]; nextBefore: string | null }>(s.workerUrl,
    `/api/threads/${threadId}/turns?limit=${page.limit}${page.before ? `&before=${page.before}` : ""}`, { token: s.token });

export const cancelTurn = (s: Settings, turnId: string) =>
  call<{ turn: TurnView }>(s.workerUrl, `/api/turns/${turnId}/cancel`, { token: s.token, body: {} });

export const retryTurn = (s: Settings, turnId: string, idempotencyKey: string) =>
  call<{ turn: TurnView }>(s.workerUrl, `/api/turns/${turnId}/retry`, { token: s.token, body: { idempotencyKey } });

/** With `waitMs`, the Worker holds the request until a call exists (or the wait ends) while a turn is active. */
export const claimBrowserCall = (s: Settings, waitMs = 0) =>
  call<{ call: ClaimedBrowserCall | null; activeTurns: number }>(s.workerUrl, "/api/browser/claim", { token: s.token, body: { waitMs } });

export const completeBrowserCall = (s: Settings, input: { callId: string; leaseId: string; result?: BrowserResult | RunCodeResult; errorCode?: string; message?: string }) =>
  call<{ accepted: boolean }>(s.workerUrl, "/api/browser/complete", { token: s.token, body: input });

export const listRoutines = (s: Settings) => call<RoutineListView>(s.workerUrl, "/api/routines", { token: s.token });

export const getRoutine = (s: Settings, threadId: string) => call<RoutineDetailView>(s.workerUrl, `/api/routines/${threadId}`, { token: s.token });

/** Creates a Routine (no `threadId`) or replaces one's definition. */
export const saveRoutine = (s: Settings, threadId: string | undefined, request: RoutineSaveRequest) =>
  call<RoutineDetailView>(s.workerUrl, threadId ? `/api/routines/${threadId}` : "/api/routines", { method: threadId ? "PUT" : "POST", token: s.token, body: request });

/** Archives a Routine with its runs and stops its schedule. */
export const deleteRoutine = (s: Settings, threadId: string) =>
  call<{ thread: RoutineThreadView }>(s.workerUrl, `/api/routines/${threadId}`, { method: "DELETE", token: s.token });

/** One run now; `permissions` can only narrow the Routine's own. */
export const runRoutine = (s: Settings, threadId: string, input: { idempotencyKey: string; permissions?: RoutinePermissions }) =>
  call<RoutineRunResult>(s.workerUrl, `/api/routines/${threadId}/runs`, { token: s.token, body: input });

/** Only the PDF's URL is sent; the Worker fetches it itself, without any of the user's cookies. */
export const readPdfText = (s: Settings, request: PdfTextRequest) =>
  call<PdfTextResponse>(s.workerUrl, "/api/pdf/text", { token: s.token, body: request });
