// Generates wrangler.jsonc from src/config.ts, the single source of deployment inputs.
// Usage: node scripts/wrangler-config.ts          write wrangler.jsonc
//        node scripts/wrangler-config.ts --check  fail if the committed file is stale
// The Cloudflare account id is never written here: wrangler reads CLOUDFLARE_ACCOUNT_ID.
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { PI_TEXT_RULE, workerAliases } from "agent-core/worker-bundle";
import {
  ACCOUNT_DO_BINDING, ACCOUNT_DO_CLASS, AI_BINDING, ACCOUNT_DO_MIGRATION_TAG, COMPATIBILITY_DATE, COMPATIBILITY_FLAGS, SANDBOX_ASSETS_DIR, VERSION, WORKER_NAME,
} from "../src/config.ts";

export function wranglerConfig(): string {
  // Pi (pi-coding-agent, run by agent-core's Pi layer) is staged by scripts/prepare-pi.ts, the build
  // command, through agent-core's shared Worker build: the entry carries Pi's package resources,
  // and every import of Pi, pi-ai or Pi's TypeBox validator settings resolves to the one staged copy.
  const config = {
    $schema: "node_modules/wrangler/config-schema.json",
    name: WORKER_NAME,
    main: ".wrangler/pi/worker.mjs",
    base_dir: ".wrangler/pi",
    find_additional_modules: true,
    preserve_file_names: true,
    minify: true,
    alias: workerAliases("./.wrangler/pi"),
    rules: [PI_TEXT_RULE],
    // The same command writes the shell Worker of run_code's bash runs (scripts/build-sandbox.ts)
    // into the static assets, which are served before the Worker runs.
    build: { command: "node scripts/prepare-pi.ts && node scripts/build-sandbox.ts", watch_dir: ["src"] },
    assets: { directory: `./${SANDBOX_ASSETS_DIR}` },
    compatibility_date: COMPATIBILITY_DATE,
    compatibility_flags: [...COMPATIBILITY_FLAGS],
    workers_dev: true,
    observability: { enabled: true },
    vars: { WORKER_VERSION: VERSION },
    durable_objects: { bindings: [{ name: ACCOUNT_DO_BINDING, class_name: ACCOUNT_DO_CLASS }] },
    migrations: [{ tag: ACCOUNT_DO_MIGRATION_TAG, new_sqlite_classes: [ACCOUNT_DO_CLASS] }],
    ai: { binding: AI_BINDING },
  };
  return `// Generated from src/config.ts by scripts/wrangler-config.ts. Do not edit by hand.\n${JSON.stringify(config, null, 2)}\n`;
}

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const path = join(root, "wrangler.jsonc");

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  if (process.argv.includes("--check")) {
    if (readFileSync(path, "utf8") !== wranglerConfig()) {
      console.error("wrangler.jsonc is stale: run `npm run wrangler:config`");
      process.exit(1);
    }
    console.log("ok: wrangler.jsonc matches src/config.ts");
  } else {
    writeFileSync(path, wranglerConfig());
    console.log(`wrote ${path}`);
  }
}
