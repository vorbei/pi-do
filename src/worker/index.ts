// HTTP edge of the Worker: CORS, bootstrap, bearer-token auth and routing to the account's
// Durable Object. Requests carry no browser credentials; the account token is the only secret
// the extension sends, and it authorizes nothing but this account's own turns.
import { VERSION } from "../config.ts";
import { parseMemoryPermission, parsePdfTextRequest, parseRoutineRun, parseRoutineSave, parseTabContext, parseTurnImages, ProtocolError } from "../shared/protocol.ts";
import { AccountDO, type Env } from "./account-do.ts";
import { createId, createSecret, sha256 } from "agent-core/runtime";
import { MAX_CLAIM_WAIT_MS } from "./turns.ts";

export { AccountDO };

const MAX_BODY_BYTES = 3_000_000;

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    if (request.method === "OPTIONS") return cors(new Response(null, { status: 204 }));
    try {
      return cors(await route(request, env));
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      // Contract and runtime errors carry their code as the message prefix, also across RPC.
      const code = error instanceof ProtocolError ? error.code : message.match(/^([A-Z][A-Z0-9_]{2,63})(?::|$)/)?.[1] ?? "INTERNAL_ERROR";
      if (code === "INTERNAL_ERROR") console.error(JSON.stringify({ event: "request.failed", message: message.slice(0, 300) }));
      const status = code === "UNAUTHORIZED" ? 401 : code === "NOT_FOUND" ? 404 : code === "INTERNAL_ERROR" ? 500 : 400;
      return cors(json({ error: code }, status));
    }
  },
} satisfies ExportedHandler<Env>;

async function route(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  const path = url.pathname.replace(/\/+$/, "");
  if (request.method === "GET" && path === "/api/health") return json({ ok: true, version: VERSION });
  if (request.method === "POST" && path === "/api/bootstrap") return json(await bootstrap(await body(request), env), 201);

  const stub = await authenticate(request, env);
  let match: RegExpMatchArray | null;
  if (request.method === "POST" && path === "/api/turns") {
    const input = await body(request);
    return json({ turn: await stub.submitMessage({
      threadId: String(input.threadId ?? ""), text: String(input.text ?? ""),
      context: parseTabContext(input.context ?? null), idempotencyKey: String(input.idempotencyKey ?? ""),
      memory: parseMemoryPermission(input.memory), images: parseTurnImages(input.images),
    }) });
  }
  // One image the user attached to a message, as its bytes (the panel shows it again after a reload).
  if (request.method === "GET" && (match = path.match(/^\/api\/turns\/(turn_[a-f0-9]{32})\/images\/([0-9])$/))) {
    const image = await stub.turnImage(match[1], Number(match[2]));
    if (!image) throw new Error("NOT_FOUND");
    return new Response(Uint8Array.from(atob(image.data), character => character.charCodeAt(0)),
      { headers: { "Content-Type": image.mimeType, "Cache-Control": "private, max-age=86400, immutable" } });
  }
  // The thread list: threads with a message, newest activity first.
  if (request.method === "GET" && path === "/api/threads") {
    return json(await stub.listThreads(Number(url.searchParams.get("limit")) || undefined));
  }
  // Deleting a thread archives it (X Gardener's DELETE /v1/agent/threads/:threadId): its turns stay.
  if (request.method === "DELETE" && (match = path.match(/^\/api\/threads\/([A-Za-z0-9_-]{1,80})$/))) {
    return json({ thread: await stub.deleteThread(match[1]) });
  }
  if (request.method === "GET" && (match = path.match(/^\/api\/threads\/([A-Za-z0-9_-]{1,80})\/turns$/))) {
    // One page, oldest first; `nextBefore` is the `before` of the page before it.
    const before = url.searchParams.get("before");
    return json(await stub.listTurns(match[1], { before: before && /^turn_[a-f0-9]{32}$/.test(before) ? before : null,
      limit: Number(url.searchParams.get("limit")) || undefined }));
  }
  if (request.method === "POST" && (match = path.match(/^\/api\/turns\/(turn_[a-f0-9]{32})\/cancel$/))) {
    return json({ turn: await stub.cancelTurn(match[1]) });
  }
  if (request.method === "POST" && (match = path.match(/^\/api\/turns\/(turn_[a-f0-9]{32})\/retry$/))) {
    return json({ turn: await stub.retryTurn(match[1], String((await body(request)).idempotencyKey ?? "")) });
  }
  if (request.method === "POST" && path === "/api/browser/claim") {
    const waitMs = Number((await body(request)).waitMs);
    return json(await stub.claimBrowserCall(Number.isFinite(waitMs) ? Math.max(0, Math.min(waitMs, MAX_CLAIM_WAIT_MS)) : 0));
  }
  if (request.method === "POST" && path === "/api/browser/complete") {
    const input = await body(request);
    return json(await stub.completeBrowserCall({
      callId: String(input.callId ?? ""), leaseId: String(input.leaseId ?? ""), result: input.result,
      errorCode: typeof input.errorCode === "string" && /^[A-Z][A-Z0-9_]{2,63}$/.test(input.errorCode) ? input.errorCode : undefined,
      message: typeof input.message === "string" ? input.message : undefined,
    }));
  }
  // Routines: a schedule and a prompt; each run is a thread whose first turn is the prompt (its runs
  // are listed with the threads, and deleted as threads).
  if (path === "/api/routines") {
    if (request.method === "GET") return json(await stub.listRoutines());
    if (request.method === "POST") return json(await stub.createRoutine(parseRoutineSave(await body(request))), 201);
  }
  if ((match = path.match(/^\/api\/routines\/(routine_[a-f0-9]{32})$/))) {
    if (request.method === "GET") return json(await stub.getRoutine(match[1]));
    if (request.method === "PUT") return json(await stub.updateRoutine(match[1], parseRoutineSave(await body(request))));
    if (request.method === "DELETE") return json({ thread: await stub.deleteRoutine(match[1]) });
  }
  if (request.method === "POST" && (match = path.match(/^\/api\/routines\/(routine_[a-f0-9]{32})\/runs$/))) {
    return json(await stub.runRoutine(match[1], parseRoutineRun(await body(request))));
  }
  // Memory: the user reviews standing instructions, facts and events; confirms instructions and removes any.
  if (request.method === "GET" && path === "/api/memory") return json(await stub.listMemory());
  if (request.method === "POST" && (match = path.match(/^\/api\/memory\/(mem_[a-f0-9]{32})\/(confirm|forget)$/))) {
    return json(match[2] === "confirm" ? await stub.confirmMemory(match[1]) : await stub.forgetMemory(match[1]));
  }
  // The PDF a tab shows, read by its URL alone (fetched without cookies, converted by Workers AI,
  // cached per account in its Durable Object).
  if (request.method === "POST" && path === "/api/pdf/text") return json(await stub.readPdfText(parsePdfTextRequest(await body(request))));
  throw new Error("NOT_FOUND");
}

// Creates an account when the caller knows the operator's BOOTSTRAP_SECRET. Returns the
// account token once; the Durable Object stores only its hash.
async function bootstrap(input: Record<string, unknown>, env: Env) {
  if (!env.BOOTSTRAP_SECRET) throw new Error("BOOTSTRAP_DISABLED");
  if (typeof input.bootstrapSecret !== "string" || await sha256(input.bootstrapSecret) !== await sha256(env.BOOTSTRAP_SECRET)) {
    throw new Error("UNAUTHORIZED");
  }
  const accountId = createId("acct");
  const token = `${accountId}.${createSecret()}`;
  await env.ACCOUNTS.getByName(accountId).bootstrap(accountId, token);
  return { accountId, token };
}

async function authenticate(request: Request, env: Env) {
  const header = request.headers.get("Authorization") ?? "";
  const token = header.startsWith("Bearer ") ? header.slice(7) : "";
  const accountId = token.split(".")[0];
  if (!/^acct_[a-f0-9]{32}$/.test(accountId)) throw new Error("UNAUTHORIZED");
  const stub = env.ACCOUNTS.getByName(accountId);
  if (!await stub.authenticate(token)) throw new Error("UNAUTHORIZED");
  return stub;
}

async function body(request: Request): Promise<Record<string, unknown>> {
  const text = await request.text();
  if (text.length > MAX_BODY_BYTES) throw new Error("BODY_TOO_LARGE");
  let value: unknown;
  try { value = JSON.parse(text || "{}"); } catch { throw new Error("INVALID_JSON"); }
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("INVALID_JSON");
  return value as Record<string, unknown>;
}

function json(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), { status, headers: { "Content-Type": "application/json", "Cache-Control": "no-store" } });
}

// The API is token-authenticated (no cookies), so any origin may call it; the extension's
// origin differs per install.
function cors(response: Response): Response {
  const headers = new Headers(response.headers);
  headers.set("Access-Control-Allow-Origin", "*");
  headers.set("Access-Control-Allow-Methods", "GET, POST, PUT, DELETE, OPTIONS");
  headers.set("Access-Control-Allow-Headers", "Authorization, Content-Type");
  return new Response(response.body, { status: response.status, headers });
}
