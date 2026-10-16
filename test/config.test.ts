import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { REQUIRED_SECRETS } from "../src/config.ts";
import { missingEnvironment, missingSecrets, parseSecretNames } from "../scripts/check-secrets.ts";
import { wranglerConfig } from "../scripts/wrangler-config.ts";
import { configuredModel } from "../src/worker/model.ts";

describe("deployment config", () => {
  it("commits a wrangler.jsonc generated from src/config.ts, with no account id in it", () => {
    const committed = readFileSync(new URL("../wrangler.jsonc", import.meta.url), "utf8");
    expect(committed).toBe(wranglerConfig());
    expect(committed).not.toMatch(/account_id/);
  });

  it("requires the OpenRouter key and the bootstrap secret by name", () => {
    expect(Object.keys(REQUIRED_SECRETS).sort()).toEqual(["BOOTSTRAP_SECRET", "OPENROUTER_API_KEY"]);
  });

  it("reports missing secrets from `wrangler secret list` output", () => {
    const output = 'some banner\n[{"name":"OPENROUTER_API_KEY","type":"secret_text"}]';
    expect(parseSecretNames(output)).toEqual(["OPENROUTER_API_KEY"]);
    expect(missingSecrets(parseSecretNames(output))).toEqual(["BOOTSTRAP_SECRET"]);
    expect(missingSecrets(["OPENROUTER_API_KEY", "BOOTSTRAP_SECRET"])).toEqual([]);
    expect(() => parseSecretNames('{"error":true}')).toThrow();
  });

  it("the model reads images (the user's and screenshots) unless MODEL_IMAGE_INPUT is false", () => {
    expect(configuredModel({}).input).toEqual(["text", "image"]);
    expect(configuredModel({ MODEL_NAME: "some/text-model", MODEL_IMAGE_INPUT: "false" }).input).toEqual(["text"]);
  });

  it("requires the Cloudflare account and token from the environment", () => {
    expect(missingEnvironment({})).toEqual(["CLOUDFLARE_ACCOUNT_ID", "CLOUDFLARE_API_TOKEN"]);
    expect(missingEnvironment({ CLOUDFLARE_ACCOUNT_ID: "x", CLOUDFLARE_API_TOKEN: "y" })).toEqual([]);
  });
});
