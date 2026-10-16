// Builds the shell Worker of run_code's bash runs (agent-core's code runtime with just-bash, from
// src/ext/code-shell-worker.ts) and its content address. The extension pins the hash at its build
// (scripts/build-extension.ts); the Worker serves the file as a static asset at deploy (wrangler's
// build command runs this script), so the extension does not ship just-bash.
// Usage: node scripts/build-sandbox.ts   writes SANDBOX_ASSETS_DIR
import { copyFileSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { buildShellSandbox as buildCoreShellSandbox } from "agent-core/code-sandbox-build";
import { SANDBOX_ASSETS_DIR, SHELL_SANDBOX_PATH } from "../src/config.ts";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

/** What the extension pins and the Worker serves: the bundle, its SHA-256, just-bash's version and the file's URL path. */
export interface ShellSandbox { text: string; sha256: string; version: string; path: string; }

/** The shell Worker's bundle (agent-core's shared build); the same sources give the same bytes, so both builds agree on the hash. */
export function buildShellSandbox(): Promise<ShellSandbox> {
  return buildCoreShellSandbox({ build: build as never, root, entry: join(root, "src/ext/code-shell-worker.ts"), pathPrefix: SHELL_SANDBOX_PATH });
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const sandbox = await buildShellSandbox();
  const out = join(root, SANDBOX_ASSETS_DIR);
  rmSync(out, { recursive: true, force: true });
  mkdirSync(join(out, SHELL_SANDBOX_PATH), { recursive: true });
  writeFileSync(join(out, sandbox.path), sandbox.text);
  copyFileSync(join(root, "node_modules/just-bash/LICENSE"), join(out, SHELL_SANDBOX_PATH, "just-bash-LICENSE.txt"));
  // A content-addressed file never changes: cached for good, readable from the extension's origin.
  writeFileSync(join(out, "_headers"), `${SHELL_SANDBOX_PATH}*\n  Access-Control-Allow-Origin: *\n  Cache-Control: public, max-age=31536000, immutable\n  X-Content-Type-Options: nosniff\n`);
  console.log(`built ${sandbox.path} (${sandbox.text.length} bytes, sha256 ${sandbox.sha256})`);
}
