// The sandboxed page (agent-core's CODE_SANDBOX_PAGE): serves the panel's code runs, each in a
// fresh Worker started from code-worker.ts (bundled into CODE_WORKER_SOURCE), or for a bash run
// from the shell Worker the panel loaded and verified against its pinned hash.
import { serveCodeSandboxPage } from "agent-core/browser";

declare const CODE_WORKER_SOURCE: string;

serveCodeSandboxPage(window, { workerSource: CODE_WORKER_SOURCE });
