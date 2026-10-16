// Builds the unpacked extension into dist/extension and zips it for Chrome
// (dist/pi-do-browser-ext-extension-<version>.zip).
// Usage: node scripts/build-extension.ts [--worker-url <https://...>]
//   --worker-url prefills the Worker URL in the side panel's Settings (the user still connects
//   with the bootstrap secret); without it the field starts empty.
import { execFileSync } from "node:child_process";
import { copyFileSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { build, type Plugin } from "esbuild";
import { CODE_SANDBOX_CSP, CODE_SANDBOX_PAGE } from "agent-core/browser";
import { buildCodeSandboxScript } from "agent-core/code-sandbox-build";
import { VERSION } from "../src/config.ts";
import { buildShellSandbox } from "./build-sandbox.ts";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const urlAt = process.argv.indexOf("--worker-url");
const workerUrl = urlAt > 0 ? defaultWorkerUrl(process.argv[urlAt + 1]) : "";

/** The origin of an https Worker URL (http only for a local Worker), as the panel would store it. */
function defaultWorkerUrl(value: string | undefined): string {
  const url = new URL(value ?? "");
  const local = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
  if (url.protocol !== "https:" && !(local && url.protocol === "http:")) throw new Error(`--worker-url must be https: ${value}`);
  return url.origin;
}
const out = join(root, "dist/extension");
rmSync(out, { recursive: true, force: true });
mkdirSync(out, { recursive: true });

// The panel is agent-core's chat UI (React, JSX) with pi-do's shell. The core's files would resolve
// their packages from their own location, so React, React DOM and marked are resolved from this
// package instead: one React in the bundle, in its production build (React 19 ships that
// unminified, so the bundle is minified).
const ownPackages: Plugin = {
  name: "own-packages",
  setup(build) {
    build.onResolve({ filter: /^(react|react-dom|marked)(\/|$)/ }, args => args.resolveDir === root ? undefined
      : build.resolve(args.path, { kind: args.kind, resolveDir: root }));
  },
};
const shell = await buildShellSandbox();
await build({
  entryPoints: { panel: join(root, "src/ext/panel.tsx"), background: join(root, "src/ext/background.ts") },
  outdir: out, bundle: true, format: "iife", platform: "browser", target: "chrome116", minify: true, sourcemap: false,
  jsx: "automatic", define: { "process.env.NODE_ENV": "\"production\"", PI_DO_DEFAULT_WORKER_URL: JSON.stringify(workerUrl),
    PI_DO_SHELL_SANDBOX: JSON.stringify({ version: shell.version, sha256: shell.sha256, path: shell.path }) },
  plugins: [ownPackages], logLevel: "warning",
});

// The code sandbox (agent-core): its own Worker (the core's runtime, JavaScript runs) is bundled as
// text into the sandboxed page's script, which starts it from a blob. The shell Worker of bash runs
// (just-bash) is not shipped: the panel pins its SHA-256 and version and loads it from the Worker,
// which serves it as a static asset (scripts/build-sandbox.ts).
writeFileSync(join(out, "code-sandbox.js"), await buildCodeSandboxScript({ build: build as never, root,
  pageEntry: join(root, "src/ext/code-sandbox.ts"), workerEntry: join(root, "src/ext/code-worker.ts") }));
for (const file of ["panel.html", "panel.css"]) copyFileSync(join(root, "src/ext", file), join(out, file));
mkdirSync(join(out, "icons"), { recursive: true });
for (const size of [16, 32, 48, 128]) copyFileSync(join(root, `src/ext/icons/icon-${size}.png`), join(out, `icons/icon-${size}.png`));
const core = createRequire(join(root, "package.json"));
copyFileSync(core.resolve("agent-core/ui/chat.css"), join(out, "chat.css"));
copyFileSync(core.resolve("agent-core/ui/panel.css"), join(out, "chat-panel.css"));
copyFileSync(core.resolve("agent-core/ui/routines.css"), join(out, "routines.css"));
copyFileSync(core.resolve("agent-core/browser/code-sandbox.html"), join(out, CODE_SANDBOX_PAGE));
const manifest = JSON.parse(readFileSync(join(root, "src/ext/manifest.json"), "utf8"));
// The sandboxed page and its policy come from agent-core, the one authority for both.
writeFileSync(join(out, "manifest.json"), `${JSON.stringify({ ...manifest, version: VERSION,
  sandbox: { pages: [CODE_SANDBOX_PAGE] }, content_security_policy: { sandbox: CODE_SANDBOX_CSP } }, null, 2)}\n`);

const zip = join(root, `dist/pi-do-browser-ext-extension-${VERSION}.zip`);
rmSync(zip, { force: true });
execFileSync("zip", ["-qr", zip, "."], { cwd: out });
console.log(`built ${out}${workerUrl ? ` (Worker URL ${workerUrl})` : ""}, pinning ${shell.path}\nzipped ${zip}`);
