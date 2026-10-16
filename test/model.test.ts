import { afterEach, describe, expect, it, vi } from "vitest";
import type { Context } from "@earendil-works/pi-ai";
import { configuredModel, openRouterStream, visionModel } from "../src/worker/model.ts";
import { MODEL_MAX_OUTPUT_TOKENS, VISION_MODEL_NAME, modelProfile } from "../src/config.ts";

const context: Context = { systemPrompt: "system", messages: [{ role: "user", content: "hi", timestamp: 0 }] };
const chunk = (body: Record<string, unknown>) => `data: ${JSON.stringify({ id: "gen-1", object: "chat.completion.chunk", created: 1, model: "m", ...body })}\n\n`;

/** An OpenRouter-style streamed answer whose usage chunk reports what the request cost. */
function streamed(costUsd: number | null): Response {
  const usage = { prompt_tokens: 1_000, completion_tokens: 500, total_tokens: 1_500, ...(costUsd === null ? {} : { cost: costUsd }) };
  const text = chunk({ choices: [{ index: 0, delta: { role: "assistant", content: "hello" }, finish_reason: null }] })
    + chunk({ choices: [{ index: 0, delta: {}, finish_reason: "stop" }] }) + chunk({ choices: [], usage }) + "data: [DONE]\n\n";
  // Split mid-line, as a network stream may deliver it.
  const bytes = new TextEncoder().encode(text);
  return new Response(new ReadableStream({ start(controller) {
    for (let at = 0; at < bytes.length; at += 37) controller.enqueue(bytes.slice(at, at + 37));
    controller.close();
  } }), { status: 200, headers: { "content-type": "text/event-stream" } });
}

const env = { OPENROUTER_API_KEY: "test-key" };

describe("the OpenRouter model stream", () => {
  afterEach(() => { vi.useRealTimers(); });

  it("counts a response at the cost OpenRouter reports, and at the model's listed price when none is reported", async () => {
    const model = configuredModel({});
    const billed = await openRouterStream(env, async () => streamed(0.0123))(model, context, {}).result();
    expect(billed.content).toEqual([{ type: "text", text: "hello" }]);
    expect(billed.usage.cost.total).toBe(0.0123);
    const estimated = await openRouterStream(env, async () => streamed(null))(model, context, {}).result();
    const price = modelProfile(model.id).cost;
    expect(estimated.usage.cost.total).toBeCloseTo((1_000 * price.input + 500 * price.output) / 1e6, 10);
    // Another MODEL_NAME is estimated at its own price, not the default model's.
    const other = await openRouterStream(env, async () => streamed(null))(configuredModel({ MODEL_NAME: "anthropic/claude-opus-5.5" }), context, {}).result();
    expect(other.usage.cost.total).toBeGreaterThan(estimated.usage.cost.total);
  });

  it("sends Pi's reasoning option as OpenRouter's reasoning effort, and no reasoning field otherwise", async () => {
    const bodies: Record<string, unknown>[] = [];
    const fetchImpl = async (_input: unknown, init?: RequestInit) => { bodies.push(JSON.parse(String(init?.body))); return streamed(0.001); };
    const unlisted = configuredModel({ MODEL_NAME: "vendor/unlisted-model" });
    await openRouterStream(env, fetchImpl as typeof fetch)(unlisted, context, {}).result();
    await openRouterStream(env, fetchImpl as typeof fetch)(unlisted, context, { reasoning: "low", maxTokens: 16_384 }).result();
    expect(bodies[0]).not.toHaveProperty("reasoning");
    expect(bodies[1]).toMatchObject({ reasoning: { effort: "low" } });
    expect(JSON.stringify(bodies[1])).toContain("16384");
  });

  it("asks each model for its own reasoning effort and output cap: the vision model reasons at medium effort with a larger cap", async () => {
    const bodies: Record<string, any>[] = [];
    const fetchImpl = (async (_input: unknown, init?: RequestInit) => { bodies.push(JSON.parse(String(init?.body))); return streamed(null); }) as typeof fetch;
    const vision = await openRouterStream(env, fetchImpl)(visionModel({}), context, {}).result();
    await openRouterStream(env, fetchImpl)(configuredModel({}), context, {}).result();
    await openRouterStream(env, fetchImpl)(configuredModel({ MODEL_NAME: "anthropic/claude-haiku-5.5" }), context, {}).result();
    // The output recovery's "low" wins over the model's own effort.
    await openRouterStream(env, fetchImpl)(visionModel({}), context, { reasoning: "low" }).result();
    expect(bodies[0]).toMatchObject({ model: VISION_MODEL_NAME, reasoning: { effort: "medium" }, provider: { order: ["openai"], allow_fallbacks: true, quantizations: ["bf16", "fp16", "fp32", "unknown"] } });
    // The default model (DeepSeek) has no provider order but never reaches an fp8/fp4 endpoint.
    expect(bodies[1].provider).toEqual({ quantizations: ["bf16", "fp16", "fp32", "unknown"] });
    expect(JSON.stringify(bodies[0])).toContain(String(modelProfile(VISION_MODEL_NAME).maxOutputTokens));
    // The default model reasons at low effort, so a normal answer fits its 8192-token cap.
    expect(bodies[1]).toMatchObject({ reasoning: { effort: "low" } });
    expect(JSON.stringify(bodies[1])).toContain(String(MODEL_MAX_OUTPUT_TOKENS));
    // Anthropic models reason at their default too: their signed reasoning is kept without an effort.
    expect(bodies[2]).not.toHaveProperty("reasoning");
    expect(bodies[3]).toMatchObject({ reasoning: { effort: "low" } });
    // A response without a reported cost is estimated at the vision model's price.
    const price = modelProfile(VISION_MODEL_NAME).cost;
    expect(vision.usage.cost.total).toBeCloseTo((1_000 * price.input + 500 * price.output) / 1e6, 10);
  });

  it("keeps reasoning a model returned only signed and sends it back on the next request", async () => {
    const signed = { type: "reasoning.text", signature: "c2lnbmVk", format: "anthropic-claude-v1", index: 0 };
    const bodies: Record<string, any>[] = [];
    const answers = [
      chunk({ choices: [{ index: 0, delta: { role: "assistant", content: "", reasoning_details: [signed] }, finish_reason: null }] })
        + chunk({ choices: [{ index: 0, delta: { content: "first" }, finish_reason: "stop" }] }),
      chunk({ choices: [{ index: 0, delta: { role: "assistant", content: "second" }, finish_reason: "stop" }] }),
    ];
    const fetchImpl = (async (_input: unknown, init?: RequestInit) => {
      bodies.push(JSON.parse(String(init?.body)));
      return new Response(`${answers.shift()}data: [DONE]\n\n`, { status: 200, headers: { "content-type": "text/event-stream" } });
    }) as typeof fetch;
    const model = configuredModel({ MODEL_NAME: "anthropic/claude-haiku-5.5" });
    const first = await openRouterStream(env, fetchImpl)(model, context, {}).result();
    const next: Context = { ...context, messages: [...context.messages, first, { role: "user", content: "and?", timestamp: 0 }] };
    await openRouterStream(env, fetchImpl)(model, next, {}).result();
    // The answer is the end of the history, so it also carries the prompt-cache breakpoint.
    expect(bodies[1].messages.find((message: any) => message.role === "assistant")).toMatchObject({ content: [{ type: "text", text: "first", cache_control: { type: "ephemeral" } }], reasoning_details: [{ ...signed, text: "" }] });
  });

  it("fails a request the model's timeout cut as MODEL_TIMEOUT, not as an abort; a cancel stays an abort", async () => {
    vi.useFakeTimers();
    const hanging = (async (_input: unknown, init?: RequestInit) => new Promise<Response>((_, reject) =>
      init?.signal?.addEventListener("abort", () => reject(Object.assign(new Error("aborted"), { name: "AbortError" })), { once: true }))) as typeof fetch;
    const model = configuredModel({});
    const pending = openRouterStream(env, hanging)(model, context, {}).result();
    await vi.advanceTimersByTimeAsync(modelProfile(model.id).timeoutMs + 1);
    expect(await pending).toMatchObject({ stopReason: "error", errorCode: "MODEL_TIMEOUT" });

    const cancel = new AbortController();
    const cancelled = openRouterStream(env, hanging)(model, context, { signal: cancel.signal }).result();
    cancel.abort();
    expect(await cancelled).toMatchObject({ stopReason: "aborted" });
  });
});
