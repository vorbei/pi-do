// The model behind the agent loop: an OpenAI-compatible (OpenRouter) model definition and
// Pi's own openai-completions stream, bounded by the model's request timeout, with each response's
// cost as OpenRouter billed it.
import type { AssistantMessage, Model, SimpleStreamOptions, StreamFunction } from "@earendil-works/pi-ai";
import { streamSimple } from "@earendil-works/pi-ai/api/openai-completions";
import { fullPrecisionProvider, markPromptCache, withModelDeadline, withSignedReasoning } from "agent-core/pi";
import { DEFAULT_MODEL, MODEL_CONTEXT_WINDOW, MODEL_MAX_OUTPUT_TOKENS, OPENROUTER_BASE_URL, VISION_MODEL_NAME, modelProfile } from "../config.ts";

/** A model request as Pi's agent loop makes it. */
export type StreamFn = StreamFunction<any, SimpleStreamOptions>;

export interface ModelEnv { OPENROUTER_API_KEY?: string; MODEL_NAME?: string; MODEL_BASE_URL?: string; MODEL_IMAGE_INPUT?: string; }

/**
 * The model of turns without images; it reads images unless MODEL_IMAGE_INPUT is "false" (then Pi
 * sends a placeholder for a screenshot). Its price and output cap are its MODEL_PROFILES entry's.
 */
export function configuredModel(env: ModelEnv): Model<"openai-completions"> {
  return openRouterModel(env, env.MODEL_NAME?.trim() || DEFAULT_MODEL, env.MODEL_IMAGE_INPUT?.trim() !== "false");
}

/** The model of a turn whose message carries images: VISION_MODEL_NAME. */
export function visionModel(env: ModelEnv): Model<"openai-completions"> {
  return openRouterModel(env, VISION_MODEL_NAME, true);
}

function openRouterModel(env: ModelEnv, id: string, images: boolean): Model<"openai-completions"> {
  const profile = modelProfile(id);
  return {
    id, name: id, api: "openai-completions", provider: "openrouter",
    baseUrl: env.MODEL_BASE_URL?.trim() || OPENROUTER_BASE_URL,
    // Pi sends no reasoning field for this model; openRouterStream sends the profile's effort.
    reasoning: false, input: images ? ["text", "image"] : ["text"], cost: { ...profile.cost },
    contextWindow: MODEL_CONTEXT_WINDOW, maxTokens: profile.maxOutputTokens ?? MODEL_MAX_OUTPUT_TOKENS,
  } as Model<"openai-completions">;
}

/**
 * Pi's OpenAI-compatible stream with the Worker secret as the key, cut after the model's timeout
 * (agent-core's deadline: MODEL_TIMEOUT). A response's `usage.cost.total` is what OpenRouter
 * reported it billed (`usage.cost` in the stream's usage chunk), else Pi's estimate from the
 * model's listed price. Reasoning a provider signed without showing it (Anthropic asked for no
 * effort) is kept and sent back on the turn's next request (agent-core's withSignedReasoning). Each request sends the model's reasoning effort (MODEL_PROFILES) as
 * OpenRouter's `reasoning.effort`, or Pi's `reasoning` option when given (agent-core's output
 * recovery asks for "low"): the model is declared without reasoning, so Pi sends no reasoning
 * field of its own. Every request accepts only full-precision endpoints (agent-core's
 * fullPrecisionProvider), after the model's provider order when it has one.
 */
export function openRouterStream(env: ModelEnv, fetchImpl: typeof fetch = (input, init) => fetch(input, init)): StreamFn {
  const apiKey = env.OPENROUTER_API_KEY;
  const stream: StreamFn = (model, context, options) => {
    if (!apiKey) throw new Error("MODEL_API_KEY_MISSING: the Worker secret OPENROUTER_API_KEY is not set");
    const billed: { usd?: number } = {};
    const effort = options?.reasoning ?? modelProfile(model.id).reasoning;
    const order = modelProfile(model.id).providerOrder;
    const provider = { provider: fullPrecisionProvider(order?.length ? { order: [...order], allow_fallbacks: true } : null) };
    const source = streamSimple(model as Model<"openai-completions">, context, {
      ...options, apiKey, fetch: billedCostFetch(withSignedReasoning(fetchImpl), billed),
      onPayload: async (params, payloadModel) => {
        const payload = (await options?.onPayload?.(params, payloadModel)) ?? params;
        markPromptCache(model.id, (payload as { messages?: unknown[] }).messages ?? []);
        return { ...(payload as object), ...provider, ...(effort ? { reasoning: { effort } } : {}) };
      },
      headers: { ...options?.headers, "X-Title": "pi-do-browser-ext" },
    });
    const bill = (message: AssistantMessage) => {
      if (Number.isFinite(billed.usd) && message.usage) message.usage.cost = { ...message.usage.cost, total: billed.usd! };
      return message;
    };
    return {
      async *[Symbol.asyncIterator]() {
        for await (const event of source) {
          if (event.type === "done") bill(event.message);
          else if (event.type === "error") bill(event.error);
          yield event;
        }
      },
      result: async () => bill(await source.result()),
    } as unknown as ReturnType<StreamFn>;
  };
  return withModelDeadline(stream, model => modelProfile(model.id).timeoutMs);
}

/** A fetch that passes the streamed response through and keeps the `usage.cost` of its usage chunk. */
function billedCostFetch(fetchImpl: typeof fetch, billed: { usd?: number }): typeof fetch {
  return async (input, init) => {
    const response = await fetchImpl(input, init);
    if (!response.ok || !response.body) return response;
    const decoder = new TextDecoder();
    let line = "";
    const read = (text: string) => {
      const lines = (line + text).split("\n");
      line = lines.pop() ?? "";
      for (const data of lines) {
        if (!data.startsWith("data:") || !data.includes('"usage"')) continue;
        try {
          const cost = (JSON.parse(data.slice(5)) as { usage?: { cost?: unknown } }).usage?.cost;
          if (typeof cost === "number" && Number.isFinite(cost)) billed.usd = cost;
        } catch { /* not a JSON chunk */ }
      }
    };
    const body = response.body.pipeThrough(new TransformStream<Uint8Array, Uint8Array>({
      transform(chunk, controller) { read(decoder.decode(chunk, { stream: true })); controller.enqueue(chunk); },
      flush() { read(`${decoder.decode()}\n`); },
    }));
    return new Response(body, { status: response.status, statusText: response.statusText, headers: response.headers });
  };
}
