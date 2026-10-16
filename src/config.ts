// Every deployment input of the Worker, in one place. `wrangler.jsonc` is generated from
// these constants (`npm run wrangler:config`) and a test fails when the two drift.
// Secret VALUES never appear in this repository: only their names are declared here.

/** Release version, shared by the Worker (`/api/health`) and the extension manifest. */
export const VERSION = "0.1.11";

/** Cloudflare Worker script name. Distinct from any other project, so deployments never overlap. */
export const WORKER_NAME = "pi-do-browser-ext";

/** Durable Object class that owns one account: its turns, journal and browser-call queue. */
export const ACCOUNT_DO_CLASS = "AccountDO";
/** Binding name of the AccountDO namespace inside the Worker env. */
export const ACCOUNT_DO_BINDING = "ACCOUNTS";
/** Durable Object migration tag that created the SQLite-backed AccountDO class. */
export const ACCOUNT_DO_MIGRATION_TAG = "v1";

/**
 * Binding name of Workers AI inside the Worker env. Its only use is `toMarkdown`, which converts
 * the PDF a `read_text` targets into text (no model is called for a PDF).
 */
export const AI_BINDING = "AI";

/**
 * Workers Static Assets directory (relative to this package) that `scripts/build-sandbox.ts` writes
 * at the Worker build: the shell Worker of run_code's bash runs (just-bash, about 1.3 MB, too large
 * for the Worker script's own budget), its license and its `_headers`. Served before the Worker.
 */
export const SANDBOX_ASSETS_DIR = "dist/sandbox";
/** URL path of those assets; the shell Worker is `<path>just-bash-<version>-<sha256>.js`. */
export const SHELL_SANDBOX_PATH = "/sandbox/";

/** Workers runtime compatibility date. Bump deliberately and re-run the tests and smoke. */
export const COMPATIBILITY_DATE = "2026-09-05";
/** `nodejs_compat` is required: the Pi packages use Node built-ins (for example `node:crypto`). */
export const COMPATIBILITY_FLAGS = ["nodejs_compat"] as const;

/** OpenAI-compatible endpoint the model requests go to. Override per environment with the MODEL_BASE_URL var. */
export const OPENROUTER_BASE_URL = "https://openrouter.ai/api/v1";
/**
 * Default OpenRouter model id. Override per environment with the MODEL_NAME var. It reads images
 * (OpenRouter lists its input modalities as text and image, checked 2026-10-10): screenshots and the
 * images a user attaches reach it as image content. A text-only MODEL_NAME needs MODEL_IMAGE_INPUT=false.
 */
export const DEFAULT_MODEL = "deepseek/deepseek-v4.1-flash";
export const MODEL_CONTEXT_WINDOW = 131_072;
export const MODEL_MAX_OUTPUT_TOKENS = 8_192;
/** One model request is aborted after this long, unless MODEL_PROFILES says otherwise for the model. */
export const MODEL_TIMEOUT_MS = 90_000;

/**
 * The OpenRouter model a turn runs on when its message carries images (pasted or dropped). Unlike
 * DEFAULT_MODEL, it solved the chess-puzzle screenshot when asked directly (g4, 2026-10-10 probes).
 * Turns without images run on MODEL_NAME (DEFAULT_MODEL).
 */
export const VISION_MODEL_NAME = "openai/gpt-6.1-sol";

/** USD per million tokens. */
export interface ModelCost { input: number; output: number; cacheRead: number; cacheWrite: number }
/** OpenRouter's normalized reasoning effort (`reasoning.effort`). */
export type ReasoningEffort = "minimal" | "low" | "medium" | "high";
/** What pi-do knows of a model by its OpenRouter id. */
export interface ModelProfile {
  /**
   * The model's listed price, used only for a response that reports no cost: OpenRouter reports
   * what it billed (`usage.cost`), and that is what a turn's spend ceiling counts.
   */
  cost: ModelCost;
  /** One request is aborted after this long and fails as MODEL_TIMEOUT (retried once). */
  timeoutMs: number;
  /** The output cap of one request (reasoning included); MODEL_MAX_OUTPUT_TOKENS when unset. */
  maxOutputTokens?: number;
  /**
   * The reasoning effort every request asks for. Unset: none is sent and the model reasons at its
   * provider's default. Reasoning comes back as text (DeepSeek) or signed without text (Anthropic
   * asked for no effort); either way the turn's next request sends it back.
   */
  reasoning?: ReasoningEffort;
  /** OpenRouter provider slugs tried first for this model, fallbacks allowed. Unset: OpenRouter's own routing. */
  providerOrder?: readonly string[];
}
/**
 * Per-model price, request timeout, output cap and reasoning. Prices are OpenRouter's listed ones
 * (https://openrouter.ai/api/v1/models, checked 2026-10-10). Reasoning models get longer timeouts:
 * claude-opus-5.5, claude-sonnet-5.5 and gemini-3.8-flash were cut at 90 s while still reasoning, and
 * gpt-5.6-sol took 108-155 s to solve the chess puzzle (pi-do chess test, 2026-10-10).
 */
export const MODEL_PROFILES: Readonly<Record<string, ModelProfile>> = {
  // Low effort, so a normal answer fits the 8192-token cap. reasoning.max_tokens is a hard cap on no
  // endpoint tried, and the effort is followed by DeepSeek's own endpoint (low finished a counting
  // prompt within the cap 5 of 5 times, its default 1 of 5) far more than by Together, where OpenRouter
  // sends these requests; pinning DeepSeek's endpoint halved the bench's cost but added ~1 s to the first
  // token of every request, so it is not pinned.
  "deepseek/deepseek-v4.1-flash": { cost: { input: 0.3, output: 1.2, cacheRead: 0.006, cacheWrite: 0 }, timeoutMs: MODEL_TIMEOUT_MS, reasoning: "low" },
  "anthropic/claude-haiku-5.5": { cost: { input: 0.1, output: 0.5, cacheRead: 0.01, cacheWrite: 0.125 }, timeoutMs: 120_000 },
  "google/gemini-3.8-flash": { cost: { input: 0.75, output: 3.75, cacheRead: 0.075, cacheWrite: 0.0417 }, timeoutMs: 180_000 },
  "anthropic/claude-sonnet-5.5": { cost: { input: 2, output: 10, cacheRead: 0.1, cacheWrite: 2.5 }, timeoutMs: 180_000 },
  // Medium, not high: on the bench's image cases medium passed as often or more (12/12 against 10/11) in
  // less time (median 132 s against 156 s) and spent half the reasoning tokens; low passed fewer.
  // OpenAI first: it served the chess decision
  // about a third faster than Azure at the same price.
  [VISION_MODEL_NAME]: { cost: { input: 2, output: 10, cacheRead: 0.1, cacheWrite: 2.5 }, timeoutMs: 300_000, maxOutputTokens: 32_768, reasoning: "medium",
    providerOrder: ["openai"] },
  "google/gemini-3.1-pro-preview": { cost: { input: 2, output: 12, cacheRead: 0.2, cacheWrite: 0.375 }, timeoutMs: 180_000 },
  "anthropic/claude-opus-5.5": { cost: { input: 4, output: 20, cacheRead: 0.2, cacheWrite: 5 }, timeoutMs: 180_000 },
};
/**
 * A MODEL_NAME not in MODEL_PROFILES: the highest listed price, so a response without a reported
 * cost errs toward reaching the spend ceiling early, and a long timeout.
 */
export const UNLISTED_MODEL_PROFILE: ModelProfile = { cost: { input: 4, output: 20, cacheRead: 0.2, cacheWrite: 5 }, timeoutMs: 180_000 };
export const modelProfile = (id: string): ModelProfile => MODEL_PROFILES[id] ?? UNLISTED_MODEL_PROFILE;

/**
 * Worker secrets the code requires, by name. `npm run check:secrets` fails the deploy when one
 * is missing on the deployed Worker; values are set with `wrangler secret put <NAME>`.
 */
export const REQUIRED_SECRETS = {
  OPENROUTER_API_KEY: "OpenRouter API key used for every model request.",
  BOOTSTRAP_SECRET: "Shared secret a user enters in the extension settings to create an account on this Worker. Without it anyone could spend the OpenRouter key.",
} as const;
export type RequiredSecret = keyof typeof REQUIRED_SECRETS;

/**
 * Worker secrets the code uses when set. web_search tries OpenRouter's web search (with
 * OPENROUTER_API_KEY), then these providers in this order.
 */
export const OPTIONAL_SECRETS = {
  TAVILY_API_KEY: "Tavily search API key: web_search's second provider.",
  BRAVE_API_KEY: "Brave Search API key: web_search's third provider.",
} as const;

/** Optional plain-text vars (not secrets). Unset means the default constant above applies. */
export const OPTIONAL_VARS = {
  MODEL_NAME: "OpenRouter model id; defaults to DEFAULT_MODEL.",
  MODEL_BASE_URL: "OpenAI-compatible base URL; defaults to OPENROUTER_BASE_URL. The local smoke points it at a fake model.",
  MODEL_IMAGE_INPUT: "\"false\" when MODEL_NAME cannot read images: screenshots then reach it as a placeholder. A message with images runs on VISION_MODEL_NAME either way. Unset: images are sent (DEFAULT_MODEL reads them).",
  PDF_TEST_CONVERTER_URL: "Local smoke only, never on a deployed Worker: with no Workers AI binding, PDFs are POSTed here for conversion and loopback PDF URLs are allowed (wrangler dev has no local Workers AI).",
} as const;

/** Environment variable that names the Cloudflare account wrangler deploys to. Never committed. */
export const CLOUDFLARE_ACCOUNT_ID_ENV = "CLOUDFLARE_ACCOUNT_ID";
/** Environment variable holding the Cloudflare API token wrangler deploys with. Never committed. */
export const CLOUDFLARE_API_TOKEN_ENV = "CLOUDFLARE_API_TOKEN";

/** Per-turn ceilings. They persist with the turn, so a resume or retry never resets them. */
export const TURN_BUDGET = {
  /**
   * Model requests per turn. The last one before the `answerRepairs` reserve is sent without
   * tools, forcing a final answer.
   */
  modelCalls: 30,
  /**
   * Model requests held back from `modelCalls` for repairing the final answer: one more tools-off
   * request when the answer was only tool-call markup written as text, or broke an explicit length limit.
   */
  answerRepairs: 1,
  /** Tool calls per turn (browser, memory and run_code). */
  toolCalls: 60,
  /** `run_code` calls per turn (agent-core's codeExec budget); each also counts as a tool call. */
  codeRuns: 6,
  /**
   * Pages of a turn that may fail to load (an "open" or "navigate" the extension reports as
   * PAGE_LOAD_FAILED or NAVIGATION_FAILED) before the turn's next "open" or "navigate" is refused,
   * telling the model to stop guessing addresses and answer (a guessed-URL loop opened 33 tabs, 2026-10-10).
   */
  failedPages: 3,
  /**
   * USD per turn, as OpenRouter billed each response (else estimated from MODEL_PROFILES); the turn
   * stops when it is reached.
   */
  costUsd: 0.5,
  /**
   * Attempts per turn (agent-core's attempt budget): its first run, every resume after a browser
   * call and every reclaim after its executor vanished (eviction, crash) is one.
   */
  attempts: 96,
} as const;

/**
 * When a thread's history is summarized (agent-core's compaction policy): once the model view
 * passes `compactAtTokens` (of the model's 131k window), everything before the last
 * `keepRecentTokens` is replaced by one summary. The summary costs one model request of the turn
 * and is abandoned after `summaryTimeoutMs` (the turn then goes on with the full history).
 */
export const CONTEXT_COMPACTION = { compactAtTokens: 80_000, keepRecentTokens: 24_000, summaryTimeoutMs: 60_000 } as const;

// A running turn's lease is agent-core's: two model timeouts (modelProfile), at least two minutes. An evicted
// attempt is reclaimed by the alarm after it expires.
/** A browser call the extension claimed must be completed within this time (covers the user's confirmation). */
export const BROWSER_CALL_LEASE_MS = 5 * 60_000;
/** A browser call no extension claims within this time fails its turn with CHROME_OFFLINE (agent-core's EXECUTOR_OFFLINE). */
export const BROWSER_CLAIM_WAIT_MS = 2 * 60_000;
/** Alarm cadence while any turn is not terminal. */
export const RECOVERY_INTERVAL_MS = 30_000;
/** Limits of the Worker's PDF read (`POST /api/pdf/text`): it fetches only public http(s) URLs, without cookies. */
export const PDF_READ = {
  /** A larger PDF is refused before conversion. */
  maxBytes: 30 * 1024 * 1024,
  /** The whole fetch, redirects and body included, is aborted after this long. */
  fetchTimeoutMs: 30_000,
  /** Redirects followed, each one validated again as a public http(s) URL. */
  maxRedirects: 5,
} as const;
/** The account's cache of PDF conversions (its Durable Object SQLite), keyed by a hash of the PDF URL. */
export const PDF_CACHE = {
  /** A cached conversion is used for this long after it was made. */
  ttlMs: 24 * 60 * 60_000,
  /** Conversions larger than this are not cached (a Durable Object SQLite value holds at most 2 MB). */
  maxEntryBytes: 1_500_000,
  /** Above this total, the least recently used conversions are dropped. */
  maxTotalBytes: 20 * 1024 * 1024,
} as const;
/** Turns that may run model requests at the same time in one account. */
export const MODEL_CONCURRENCY = 3;
