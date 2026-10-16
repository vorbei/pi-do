// Claims one executor call from the Worker (a browser action or a code run), runs it locally, and
// reports the outcome. The call's arguments are validated again here: the extension trusts nothing it is sent.
import type { CodeSandbox } from "agent-core/browser";
import { parseBrowserCall, parseRunCode, RUN_CODE_LIMITS } from "../shared/protocol.ts";
import { BrowserError } from "../browser/cdp.ts";
import { executeBrowserCall, type ExecutorDeps } from "../browser/executor.ts";
import { claimBrowserCall, completeBrowserCall, type Settings } from "./api.ts";

export async function runOneBrowserCall(settings: Settings, deps: ExecutorDeps, sandbox: CodeSandbox, onCall?: (summary: string) => void, waitMs = 0): Promise<{ ran: boolean; activeTurns: number }> {
  const { call: claimed, activeTurns } = await claimBrowserCall(settings, waitMs);
  if (!claimed) return { ran: false, activeTurns };
  onCall?.(claimed.tool === "run_code" ? `run_code (${claimed.call.language ?? "js"})` : claimed.call.action);
  try {
    // A code run never touches a tab: it runs in the sandboxed page's own Worker.
    const result = claimed.tool === "run_code" ? await sandbox.run({ ...parseRunCode(claimed.call), ...RUN_CODE_LIMITS })
      : await executeBrowserCall(deps, parseBrowserCall(claimed.call));
    await completeBrowserCall(settings, { callId: claimed.callId, leaseId: claimed.leaseId, result });
  } catch (error) {
    const code = error instanceof BrowserError ? error.code : (error as { code?: string })?.code ?? "BROWSER_FAILED";
    await completeBrowserCall(settings, { callId: claimed.callId, leaseId: claimed.leaseId,
      errorCode: /^[A-Z][A-Z0-9_]{2,63}$/.test(code) ? code : "BROWSER_FAILED", message: String((error as Error)?.message ?? error).slice(0, 1_000) });
  }
  return { ran: true, activeTurns };
}
