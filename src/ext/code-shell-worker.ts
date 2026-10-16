// The shell Worker of run_code's bash runs: agent-core's code runtime with just-bash's in-memory
// shell. Not shipped in the extension: the Worker serves it (scripts/build-sandbox.ts), and the
// panel runs it only when its SHA-256 matches the hash this extension was built with.
import { Bash } from "just-bash/browser";
import { serveCodeRun, type ShellConstructor } from "agent-core/browser";

serveCodeRun(self as unknown as typeof globalThis, { Bash: Bash as unknown as ShellConstructor });
