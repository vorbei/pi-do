// Fails a deploy when the deployed Worker lacks a secret the code requires (adapted from X
// Gardener's secrets check). Names only: values are never read or printed.
// Usage: node scripts/check-secrets.ts [--name <worker>] [--missing]
//   (needs CLOUDFLARE_ACCOUNT_ID and CLOUDFLARE_API_TOKEN). --missing prints the missing names, one
//   per line, and exits 0 (scripts/deploy.sh reads it); without it a missing secret exits 1.
import { execFileSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { CLOUDFLARE_ACCOUNT_ID_ENV, CLOUDFLARE_API_TOKEN_ENV, REQUIRED_SECRETS, WORKER_NAME } from "../src/config.ts";

/** Secret names from `wrangler secret list --format json` output. */
export function parseSecretNames(output: string): string[] {
  const start = output.indexOf("[");
  const list = JSON.parse(start >= 0 ? output.slice(start) : output) as unknown;
  if (!Array.isArray(list)) throw new Error("unexpected `wrangler secret list` output");
  return list.map(entry => (entry as { name?: unknown }).name).filter((name): name is string => typeof name === "string");
}

export function missingSecrets(present: string[], required = Object.keys(REQUIRED_SECRETS)): string[] {
  const have = new Set(present);
  return required.filter(name => !have.has(name));
}

/** Deployment environment variables that must be set (never committed). */
export function missingEnvironment(env: NodeJS.ProcessEnv): string[] {
  return [CLOUDFLARE_ACCOUNT_ID_ENV, CLOUDFLARE_API_TOKEN_ENV].filter(name => !env[name]?.trim());
}

function main(): void {
  const env = missingEnvironment(process.env);
  if (env.length) {
    console.error(`FAIL: set ${env.join(" and ")} in the shell (see README, Deploy).`);
    process.exit(1);
  }
  const nameAt = process.argv.indexOf("--name");
  const worker = nameAt > 0 ? process.argv[nameAt + 1] : WORKER_NAME;
  if (!worker || worker.startsWith("-")) {
    console.error("FAIL: --name needs a Worker name");
    process.exit(1);
  }
  const root = join(dirname(fileURLToPath(import.meta.url)), "..");
  let output: string;
  try {
    output = execFileSync(join(root, "node_modules/.bin/wrangler"), ["secret", "list", "--name", worker, "--format", "json"],
      { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "inherit"] });
  } catch {
    // A Worker that was never deployed has no secrets yet; report every name.
    output = "[]";
  }
  const missing = missingSecrets(parseSecretNames(output));
  if (process.argv.includes("--missing")) {
    if (missing.length) console.log(missing.join("\n"));
    return;
  }
  if (missing.length) {
    console.error(`FAIL: ${worker} lacks secret(s): ${missing.join(", ")}`);
    for (const name of missing) console.error(`  npx wrangler secret put ${name} --name ${worker}   # ${REQUIRED_SECRETS[name as keyof typeof REQUIRED_SECRETS]}`);
    process.exit(1);
  }
  console.log(`ok: ${worker} has every required secret (${Object.keys(REQUIRED_SECRETS).join(", ")})`);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) main();
