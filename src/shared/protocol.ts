// The wire contract between the Worker and the extension: the model's `browser` and `run_code` tool
// arguments, browser-call and code-run results, a message's images, turn, thread and Routine views and the
// confirmation rule. Both sides validate with these functions; nothing else defines these shapes. The
// Worker-only web_search and web_fetch arguments are here too, beside the other tool arguments.

import { CODE_RUN_LIMITS, codeRunRequest, type CodeRunResult } from "agent-core/browser";
import { validatePermissions, validateRoutinePrompt, validateRoutineSchedule } from "agent-core/routine";
import type { TurnProjection } from "agent-core/runtime";

// The browser tool's action model (its actions, keys, call shape and argument rules) is agent-core's
// core browser tool (agent-core/browser-tool); pi-do's wire carries its calls as they are.
export { ACTING_ACTIONS, BROWSER_ACTIONS, httpUrl, parseBrowserCall, PRESS_KEYS, type BrowserAction, type BrowserCall, type PressKey } from "agent-core/browser-tool";
import { httpUrl, type BrowserCall } from "agent-core/browser-tool";

export class ProtocolError extends Error {
  constructor(public code: string, message: string) { super(`${code}: ${message}`); }
}

/**
 * The model's `run_code` tool: JavaScript or a bash script the extension runs in agent-core's code
 * sandbox (a sandboxed extension page and a fresh Worker per run: no network, no page, no
 * extension API). The Worker queues it as an executor call like a browser action, and the
 * extension claims it, runs it with RUN_CODE_LIMITS and completes it with a RunCodeResult.
 */
export const RUN_CODE_TOOL = "run_code";
export const RUN_CODE_MAX_CHARS = CODE_RUN_LIMITS.maxCodeChars;
/** One run's limits, applied by the extension. */
export const RUN_CODE_LIMITS = {
  /** A run's Worker is terminated after this long. */
  timeoutMs: 10_000,
  /** Characters of the value (js) or of stdout (bash) the model gets back; the rest is cut and marked truncated. */
  maxOutputChars: 8_000,
} as const;
export interface RunCodeCall { language: "js" | "bash"; code: string; files?: Record<string, string>; }
const RUN_CODE_FIELDS = new Set(["language", "code", "files"]);

/** Validates raw `run_code` arguments (agent-core's request rules; `language` defaults to js), or throws ProtocolError(INVALID_ARGS). */
export function parseRunCode(input: unknown): RunCodeCall {
  const fail = (message: string): never => { throw new ProtocolError("INVALID_ARGS", message); };
  if (!input || typeof input !== "object" || Array.isArray(input)) fail("arguments must be an object");
  const raw = input as Record<string, unknown>;
  if (Object.keys(raw).some(key => !RUN_CODE_FIELDS.has(key))) fail("run_code takes only language, code and files");
  let request;
  try { request = codeRunRequest(raw); }
  catch (error) { return fail(String((error as Error).message).replace(/^[A-Z_]+: /, "")); }
  return { language: request.language, code: request.code, ...(raw.files === undefined ? {} : { files: request.files }) };
}

/**
 * The model's `web_search` and `web_fetch` tools: agent-core's web layer, run by the Worker without a
 * tab (never an executor call). A search returns untrusted snippets with their sources; a fetch the
 * readable text of one public page.
 */
export const WEB_SEARCH_TOOL = "web_search";
export const WEB_FETCH_TOOL = "web_fetch";
/** Characters of a fetched page's text the model gets back. */
export const WEB_TEXT_MAX_CHARS = 20_000;
export interface WebSearchCall { query: string; max_results: number; include_domains?: string[]; }
export interface WebFetchCall { url: string; maxBytes?: number; }
const DOMAIN = /^(?:[a-zA-Z0-9-]+\.)+[a-zA-Z]{2,}$/;

/** Validates raw `web_search` arguments (max_results defaults to 5), or throws ProtocolError(INVALID_ARGS). */
export function parseWebSearch(input: unknown): WebSearchCall {
  const fail = (message: string): never => { throw new ProtocolError("INVALID_ARGS", message); };
  const raw = (input && typeof input === "object" && !Array.isArray(input) ? input : fail("arguments must be an object")) as Record<string, unknown>;
  if (Object.keys(raw).some(key => !["query", "max_results", "include_domains"].includes(key))) fail("web_search takes only query, max_results and include_domains");
  const query = typeof raw.query === "string" ? raw.query.trim() : "";
  if (!query || query.length > 500) fail("query must be 1-500 characters");
  const max = raw.max_results ?? 5;
  if (!Number.isInteger(max) || (max as number) < 1 || (max as number) > 10) fail("max_results must be 1-10");
  const domains = raw.include_domains;
  if (domains !== undefined && (!Array.isArray(domains) || domains.length > 10 || domains.some(domain => typeof domain !== "string" || !DOMAIN.test(domain)))) {
    fail("include_domains must be at most 10 domain names like example.com");
  }
  return { query, max_results: max as number, ...(domains ? { include_domains: domains as string[] } : {}) };
}

/** Validates raw `web_fetch` arguments, or throws ProtocolError(INVALID_ARGS); the URL policy is the web layer's. */
export function parseWebFetch(input: unknown): WebFetchCall {
  const fail = (message: string): never => { throw new ProtocolError("INVALID_ARGS", message); };
  const raw = (input && typeof input === "object" && !Array.isArray(input) ? input : fail("arguments must be an object")) as Record<string, unknown>;
  if (Object.keys(raw).some(key => !["url", "maxBytes"].includes(key))) fail("web_fetch takes only url and maxBytes");
  if (typeof raw.url !== "string" || raw.url.length < 8 || raw.url.length > 2048) fail("url must be an http(s) address");
  if (raw.maxBytes !== undefined && (!Number.isInteger(raw.maxBytes) || (raw.maxBytes as number) < 1024 || (raw.maxBytes as number) > 262_144)) fail("maxBytes must be 1024-262144");
  return { url: raw.url as string, ...(raw.maxBytes === undefined ? {} : { maxBytes: raw.maxBytes as number }) };
}

/** Extension -> Worker: what a run returned (agent-core's CodeRunResult), bounded again here. */
export type RunCodeResult = CodeRunResult;
const capText = (value: unknown, max: number) => typeof value === "string" ? { text: value.slice(0, max), cut: value.length > max } : null;

export function parseRunCodeResult(input: unknown): RunCodeResult {
  const fail = (message: string): never => { throw new ProtocolError("INVALID_RESULT", message); };
  const raw = input as Record<string, unknown> | null;
  if (!raw || typeof raw.ok !== "boolean" || typeof raw.truncated !== "boolean" || !Array.isArray(raw.logs)) fail("result needs ok, logs and truncated");
  const L = CODE_RUN_LIMITS;
  let truncated = raw!.truncated as boolean;
  const logs = (raw!.logs as unknown[]).slice(0, L.logLines + 1).map(line => capText(line, L.logLineChars + 40)?.text ?? fail("logs must be strings"));
  const result: RunCodeResult = { ok: raw!.ok as boolean, logs, truncated };
  for (const [field, max] of [["value", RUN_CODE_LIMITS.maxOutputChars], ["stdout", RUN_CODE_LIMITS.maxOutputChars], ["stderr", L.stderrChars]] as const) {
    if (raw![field] === undefined) continue;
    const capped = capText(raw![field], max) ?? fail(`${field} must be a string`);
    result[field] = capped.text;
    truncated ||= capped.cut;
  }
  if (raw!.exitCode !== undefined) result.exitCode = Number.isSafeInteger(raw!.exitCode) ? raw!.exitCode as number : fail("exitCode must be an integer");
  const error = raw!.error as Record<string, unknown> | undefined;
  if (error !== undefined || !result.ok) {
    if (typeof error?.code !== "string" || !BROWSER_ERROR.test(error.code) || typeof error.message !== "string") fail("a failed run needs error.code and error.message");
    result.error = { code: error!.code as string, message: (error!.message as string).slice(0, L.errorChars),
      ...(typeof error!.name === "string" && /^[A-Za-z]{1,40}$/.test(error!.name) ? { name: error!.name } : {}) };
  }
  result.truncated = truncated;
  return result;
}

// Control names that commit something outside the browser session: messages, posts,
// purchases, form submissions, account or data changes. Matched on the accessible name.
const COMMIT_WORDS = /\b(send|post|publish|submit|tweet|reply|share|buy|purchase|order|checkout|check out|pay|place order|subscribe|sign up|register|delete|remove|confirm|transfer|donate|book|reserve|apply|upload)\b|发送|发布|提交|购买|下单|支付|付款|删除|确认|转账|订阅|注册|预订|申请|上传/i;
const SEARCH_FIELD = /search|搜索|查找/i;
// Roles whose click is judged by the control's name. `clickable` is an element without a control
// role that the snapshot found clickable (cursor:pointer, onclick, tabindex), named by its text.
const CLICKED_ROLES = new Set(["button", "link", "menuitem", "clickable"]);
const EDITABLE_ROLES = new Set(["textbox", "searchbox", "combobox"]);

/** The control a ref points at, as the extension's snapshot recorded it. */
export interface TargetSummary { role: string; name: string; inForm?: boolean; }

/**
 * Whether an action needs an explicit user confirmation in the side panel before it runs.
 * Returns the reason shown to the user, or null. Reads, navigation and scrolling never commit.
 */
export function confirmationReason(call: BrowserCall, target: TargetSummary | null, focused: TargetSummary | null): string | null {
  if (call.action === "click" && target && CLICKED_ROLES.has(target.role) && COMMIT_WORDS.test(target.name)) return `click ${target.role} "${target.name}"`;
  if (call.action === "click" && target?.role === "button" && target.inForm && !SEARCH_FIELD.test(target.name)) {
    return `click form button "${target.name}"`;
  }
  if (call.action === "type" && call.submit) {
    if (target && (target.role === "searchbox" || SEARCH_FIELD.test(target.name))) return null;
    return `type into ${target?.role ?? "field"} "${target?.name ?? ""}" and press Enter`;
  }
  // A key that activates the focused element is judged like a click on it; Enter in a text field
  // submits its form or sends a message, so it asks unless the field is a search box.
  if (call.action === "press" && (call.key === "Enter" || call.key === "Space") && focused) {
    if (EDITABLE_ROLES.has(focused.role)) {
      if (call.key === "Space" || focused.role === "searchbox" || SEARCH_FIELD.test(focused.name)) return null;
      return `press Enter in ${focused.role} "${focused.name}"`;
    }
    if (focused.role === "iframe") return `press ${call.key} in a frame whose focused element cannot be inspected`;
    return confirmationReason({ ...call, action: "click" }, focused, null) ? `press ${call.key} on ${focused.role} "${focused.name}"` : null;
  }
  return null;
}

/** What the extension returns for a browser call. */
export interface BrowserResult {
  text: string;
  image?: { data: string; mimeType: "image/jpeg" | "image/png" };
  /** The http(s) URL the acted-on tab shows after the call; the Worker matches page guides to it. */
  pageUrl?: string;
}
export const MAX_RESULT_TEXT = 60_000;
export const MAX_RESULT_IMAGE_BASE64 = 2_000_000;

export function parseBrowserResult(input: unknown): BrowserResult {
  const raw = input as Record<string, unknown> | null;
  if (!raw || typeof raw.text !== "string") throw new ProtocolError("INVALID_RESULT", "result.text must be a string");
  const result: BrowserResult = { text: raw.text.slice(0, MAX_RESULT_TEXT) };
  const image = raw.image as Record<string, unknown> | undefined;
  if (image !== undefined) {
    if (typeof image?.data !== "string" || image.data.length > MAX_RESULT_IMAGE_BASE64
      || (image.mimeType !== "image/jpeg" && image.mimeType !== "image/png")) throw new ProtocolError("INVALID_RESULT", "result.image is invalid");
    result.image = { data: image.data, mimeType: image.mimeType };
  }
  if (raw.pageUrl !== undefined) {
    const pageUrl = typeof raw.pageUrl === "string" && raw.pageUrl.length <= 2_048 ? httpUrl(raw.pageUrl) : null;
    if (!pageUrl) throw new ProtocolError("INVALID_RESULT", "result.pageUrl must be an http(s) URL");
    result.pageUrl = pageUrl;
  }
  return result;
}

/** Browser error codes the extension may report instead of a result. */
export const BROWSER_ERROR = /^[A-Z][A-Z0-9_]{2,63}$/;

/**
 * What the user allows the agent to change in long-term memory while answering a message: with
 * `update`, it may save facts and events and replace or forget memories; without it, only save a
 * new standing instruction, which waits for the user's confirmation in Memory either way.
 */
export interface MemoryPermission { update: boolean; }

/**
 * The memory permission a message carries; anything malformed allows nothing beyond a new
 * instruction. Absent or null (a panel older than 0.1.5): undefined, and the Worker allows no update.
 */
export function parseMemoryPermission(input: unknown): MemoryPermission | undefined {
  if (input === undefined || input === null) return undefined;
  return { update: (input as { update?: unknown }).update === true };
}

/** A standing instruction in the user's Memory view. */
export interface MemoryInstruction { memoryId: string; content: string; confirmed: boolean; createdAt: string; expiresAt: string | null; }

/** A fact or event the agent saved, in the user's Memory view. */
export interface MemoryEntry { memoryId: string; kind: "fact" | "event"; content: string; createdAt: string; expiresAt: string | null; }

/**
 * Worker -> extension (`GET /api/memory`): everything active in the account's long-term memory, for
 * the user to review: standing instructions (confirmed or waiting) and saved facts and events.
 * The user removes any of them with `POST /api/memory/:id/forget` and confirms an instruction with
 * `POST /api/memory/:id/confirm`.
 */
export interface MemoryView { instructions: MemoryInstruction[]; memories: MemoryEntry[]; }

/** Per-message context: the tab the user is looking at when sending. */
export interface TabContext { tabId: number; url: string; title: string; }

export function parseTabContext(input: unknown): TabContext | null {
  const raw = input as Record<string, unknown> | null;
  if (!raw) return null;
  if (!Number.isSafeInteger(raw.tabId) || typeof raw.url !== "string" || typeof raw.title !== "string") {
    throw new ProtocolError("INVALID_CONTEXT", "context needs tabId, url and title");
  }
  return { tabId: raw.tabId as number, url: raw.url.slice(0, 2_048), title: raw.title.slice(0, 300) };
}

/**
 * Extension -> Worker (`POST /api/turns`, `images`): the images the user pasted or dropped on the
 * message box, downscaled to at most TURN_IMAGE_MAX_EDGE px and re-encoded as PNG or JPEG by the
 * panel. Within the limits below a message's images fit one Durable Object SQLite value.
 */
export const TURN_IMAGE_TYPES = ["image/png", "image/jpeg"] as const;
export type TurnImageType = (typeof TURN_IMAGE_TYPES)[number];
export interface TurnImage { mimeType: TurnImageType; data: string; }
export const MAX_TURN_IMAGES = 4;
export const TURN_IMAGE_MAX_EDGE = 1_568;
/** Base64 characters of one image, and of all the images of a message. */
export const MAX_TURN_IMAGE_BASE64 = 700_000;
export const MAX_TURN_IMAGES_BASE64 = 1_400_000;
// The first bytes of each type, as base64: a PNG signature, a JPEG start-of-image marker.
const IMAGE_SIGNATURE: Record<TurnImageType, string> = { "image/png": "iVBORw0KGgo", "image/jpeg": "/9j/" };
const BASE64 = /^[A-Za-z0-9+/]+={0,2}$/;

/** A message's images (none when absent), or ProtocolError(INVALID_IMAGES). */
export function parseTurnImages(input: unknown): TurnImage[] {
  if (input === undefined || input === null) return [];
  const fail = (message: string): never => { throw new ProtocolError("INVALID_IMAGES", message); };
  if (!Array.isArray(input)) fail("images must be an array");
  const images = input as unknown[];
  if (images.length > MAX_TURN_IMAGES) fail(`at most ${MAX_TURN_IMAGES} images per message`);
  let total = 0;
  const parsed = images.map(raw => {
    const image = raw as Record<string, unknown> | null;
    const mimeType = image?.mimeType as TurnImageType;
    if (!TURN_IMAGE_TYPES.includes(mimeType)) fail(`image mimeType must be one of ${TURN_IMAGE_TYPES.join(", ")}`);
    const data = image!.data;
    if (typeof data !== "string" || data.length > MAX_TURN_IMAGE_BASE64) fail(`image data must be base64 of at most ${MAX_TURN_IMAGE_BASE64} characters`);
    if ((data as string).length % 4 !== 0 || !BASE64.test(data as string) || !(data as string).startsWith(IMAGE_SIGNATURE[mimeType])) fail(`image data is not a base64 ${mimeType}`);
    total += (data as string).length;
    return { mimeType, data: data as string };
  });
  if (total > MAX_TURN_IMAGES_BASE64) fail(`a message's images must total at most ${MAX_TURN_IMAGES_BASE64} base64 characters`);
  return parsed;
}

export type TurnStatus = "queued" | "running" | "waiting_for_browser" | "completed" | "failed" | "cancelled";
export const TERMINAL: readonly TurnStatus[] = ["completed", "failed", "cancelled"];

/**
 * A turn as the side panel sees it: agent-core's turn projection (the shared chat reads it) with
 * the user's text, and while the turn runs the answer so far. `images` lists the message's images
 * by type only (absent when it has none); the panel loads each one's bytes from
 * `GET /api/turns/<turnId>/images/<index>`.
 */
export type TurnView = TurnProjection & { status: TurnStatus; input: string; parentTurnId: null; images?: { mimeType: TurnImageType }[] };

/** A thread in the panel's thread list; a thread exists once it has a message. */
export interface ThreadView {
  threadId: string;
  /** Its first message; a Routine run's: its Routine's name. */
  title: string;
  createdAt: string;
  updatedAt: string;
  latestTurnStatus: TurnStatus;
  latestTurnUpdatedAt: string;
  /** A Routine run: the Routine it ran for, and what started it. */
  parentThreadId?: string;
  trigger?: RoutineTrigger;
}

// ---------------------------------------------------------------- Routines

/**
 * What a Routine's runs may do. `write`: act in the browser (click, type, select, press); each
 * action that commits something still needs the user's approval in the side panel
 * (`confirmationReason`). Without it a run only reads. `update`: change long-term memory.
 */
export interface RoutinePermissions { update: boolean; write: boolean; }
// A run without `write` may not make ACTING_ACTIONS (agent-core's): they act on the page.
export type RoutineTrigger = "schedule" | "manual" | "retry";
export interface RoutineSchedule {
  /** 0 is Sunday. */
  days: number[];
  localTime: string;
  timezone: string;
  enabled: boolean;
  nextAt: string | null;
  jitterMinutes?: number;
}

/** A Routine or one of its runs (a thread) as the Routine view sees it. */
export interface RoutineThreadView {
  threadId: string;
  title: string | null;
  status: "active" | "archived";
  permissions: RoutinePermissions;
  /** A Routine: its schedule and the text each run starts from. */
  schedule?: RoutineSchedule;
  routinePrompt?: string;
  /** A run: its Routine and what started it. */
  parentThreadId?: string;
  trigger?: RoutineTrigger;
  createdAt: string;
  updatedAt: string;
  latestTurnStatus: TurnStatus | null;
  latestTurnUpdatedAt: string | null;
  /** A run's answer, its first line. */
  latestTurnSummary?: string;
}
export interface RoutineLastRun { threadId: string; trigger: RoutineTrigger; status: TurnStatus | null; createdAt: string; }
/** `GET /api/routines`: the account's Routines, newest activity first, each with its newest run. */
export interface RoutineListView { version: "routine-list-projection-v1"; items: { thread: RoutineThreadView; lastRun: RoutineLastRun | null }[]; }
/** `GET /api/routines/:id` and every change: one Routine with its runs, newest first. */
export interface RoutineDetailView { version: "routine-projection-v1"; thread: RoutineThreadView; runs: RoutineThreadView[]; }
/** `POST /api/routines/:id/runs`: the run started (or the same one for a replayed key), or why none was. */
export type RoutineRunResult = { allowed: true; created: boolean; thread: RoutineThreadView } | { allowed: false; reason: string; runThreadId?: string };

/** Extension -> Worker: `POST /api/routines` (create) and `PUT /api/routines/:id` (update). */
export interface RoutineSaveRequest {
  title: string;
  routinePrompt: string;
  enabled: boolean;
  /** On create, absent means read-only: `{ update: false, write: false }`. */
  permissions?: RoutinePermissions;
  schedule: { days: number[]; localTime: string; timezone: string; jitterMinutes?: number };
  idempotencyKey: string;
}

const ROUTINE_KEY = /^[A-Za-z0-9_:.-]{8,160}$/;
const ROUTINE_SAVE_FIELDS = new Set(["threadId", "title", "routinePrompt", "enabled", "permissions", "schedule", "idempotencyKey"]);

/** Validates a Routine's save body, or throws INVALID_ROUTINE (ROUTINE_SCHEDULE_INVALID, ROUTINE_PROMPT_INVALID for those parts). */
export function parseRoutineSave(input: unknown): RoutineSaveRequest {
  const fail = (message: string): never => { throw new ProtocolError("INVALID_ROUTINE", message); };
  if (!input || typeof input !== "object" || Array.isArray(input)) fail("body must be an object");
  const raw = input as Record<string, unknown>;
  if (Object.keys(raw).some(key => !ROUTINE_SAVE_FIELDS.has(key))) fail("unknown field");
  const title = typeof raw.title === "string" ? raw.title.trim() : "";
  if (!title || title.length > 120) fail("title must be 1..120 characters");
  if (typeof raw.enabled !== "boolean") fail("enabled must be a boolean");
  if (typeof raw.idempotencyKey !== "string" || !ROUTINE_KEY.test(raw.idempotencyKey)) fail("idempotencyKey is invalid");
  // The next run is the scheduler's to know, and on/off is `enabled`: neither comes in the schedule.
  if (raw.schedule && typeof raw.schedule === "object" && ("nextAt" in raw.schedule || "enabled" in raw.schedule)) fail("schedule takes no nextAt or enabled");
  const { enabled: _enabled, nextAt: _nextAt, ...schedule } = validateRoutineSchedule({ ...(raw.schedule as object), enabled: raw.enabled });
  return {
    title,
    routinePrompt: validateRoutinePrompt(raw.routinePrompt),
    enabled: raw.enabled as boolean,
    ...(raw.permissions === undefined ? {} : { permissions: validatePermissions(raw.permissions) }),
    schedule,
    idempotencyKey: raw.idempotencyKey as string,
  };
}

/** Extension -> Worker: `POST /api/routines/:id/runs`. `permissions` only narrow the Routine's own, for this run. */
export function parseRoutineRun(input: unknown): { idempotencyKey: string; permissions?: RoutinePermissions } {
  const raw = input as Record<string, unknown> | null;
  if (typeof raw?.idempotencyKey !== "string" || !ROUTINE_KEY.test(raw.idempotencyKey)) throw new ProtocolError("INVALID_ROUTINE", "idempotencyKey is invalid");
  return { idempotencyKey: raw.idempotencyKey, ...(raw.permissions === undefined ? {} : { permissions: validatePermissions(raw.permissions) }) };
}

/**
 * Worker -> extension (`POST /api/browser/claim`): the oldest executor call of a waiting turn, a
 * browser action or a code run. A panel from before code runs moved to the extension knows no `tool`, reads every call as
 * a browser action, and fails a run_code claim as INVALID_ARGS.
 */
export type ClaimedBrowserCall = { callId: string; leaseId: string; turnId: string; threadId: string }
  & ({ tool: "browser"; call: BrowserCall } | { tool: "run_code"; call: RunCodeCall });

/**
 * Extension -> Worker (`POST /api/pdf/text`): read the PDF a tab shows. Only its URL is sent,
 * never cookies or page content; the Worker fetches it itself, so a PDF behind a login is unreadable.
 */
export interface PdfTextRequest { url: string; maxChars: number; }

export function parsePdfTextRequest(input: unknown): PdfTextRequest {
  const raw = input as Record<string, unknown> | null;
  const url = typeof raw?.url === "string" && raw.url.length <= 4_096 ? httpUrl(raw.url) : null;
  if (!url) throw new ProtocolError("INVALID_ARGS", "url must be an absolute http(s) URL");
  const maxChars = raw!.maxChars;
  if (!Number.isSafeInteger(maxChars) || (maxChars as number) < 100 || (maxChars as number) > MAX_RESULT_TEXT) {
    throw new ProtocolError("INVALID_ARGS", `maxChars must be 100..${MAX_RESULT_TEXT}`);
  }
  return { url, maxChars: maxChars as number };
}

/**
 * Worker -> extension. `text` has a `--- page N ---` line before each page from page `from`
 * (the URL's #page=N, else 1); `pages` is null when the conversion reported no page boundaries,
 * and the text is then one unsplit block. A failure names its stage: the PDF could not be
 * fetched (`fetch`: a login, an HTTP error, not a PDF, too large) or not converted (`convert`).
 */
export type PdfTextResponse =
  | { ok: true; pages: number | null; from: number; text: string }
  | { ok: false; stage: "fetch" | "convert"; reason: string };
