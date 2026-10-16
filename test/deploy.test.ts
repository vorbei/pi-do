import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const script = fileURLToPath(new URL("../scripts/deploy.sh", import.meta.url));

/** Runs the deploy script with only the given variables beyond PATH and HOME (nothing deploys: every case refuses first). */
function deploy(args: string[], env: Record<string, string> = {}) {
  const result = spawnSync(script, args, { encoding: "utf8", env: { PATH: process.env.PATH, HOME: process.env.HOME, ...env } });
  return { status: result.status, output: `${result.stdout}${result.stderr}` };
}

describe("deploy script", () => {
  it("refuses without the Cloudflare account and token, naming only what is missing", () => {
    const none = deploy([]);
    expect(none.status).toBe(1);
    expect(none.output).toMatch(/CLOUDFLARE_ACCOUNT_ID CLOUDFLARE_API_TOKEN/);

    const fakeToken = "fake-token-must-not-print";
    const tokenOnly = deploy(["--skip-check"], { CLOUDFLARE_API_TOKEN: fakeToken });
    expect(tokenOnly.status).toBe(1);
    expect(tokenOnly.output).toMatch(/set CLOUDFLARE_ACCOUNT_ID in the environment/);
    expect(tokenOnly.output).not.toContain(fakeToken);
  });

  it("rejects unknown arguments and a --name without a valid Worker name", () => {
    expect(deploy(["--bogus"]).output).toMatch(/unknown argument: --bogus/);
    expect(deploy(["--name"]).output).toMatch(/--name needs a Worker name/);
    expect(deploy(["--name", "--skip-check"]).status).toBe(1);
    expect(deploy(["--name", "Bad_Name"]).output).toMatch(/invalid Worker name/);
    expect(deploy(["--help"]).status).toBe(0);
  });
});
