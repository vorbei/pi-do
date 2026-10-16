// The code sandbox's own Worker, shipped in the extension: agent-core's code runtime for
// JavaScript runs. Bundled as text into code-sandbox.js, which starts one such Worker per run;
// bash runs use the shell Worker instead (code-shell-worker.ts).
import { serveCodeRun } from "agent-core/browser";

serveCodeRun(self as unknown as typeof globalThis);
