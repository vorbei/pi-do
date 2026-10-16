# Notice

Parts of this project were adapted from **X Gardener**, a separate project by the same author,
at commit `7f22f00` ("release 0.5.0-dev.15", branch `gardener-0.5`). The code was copied and
rewritten in TypeScript; this project does not import, depend on, or deploy with X Gardener, and
contains no X/Twitter-specific logic. X Gardener's repository carries no license file; the
adapted code is relicensed here under this repository's MIT license by its author.

| This project | Adapted from (X Gardener `7f22f00`) | What was kept |
| --- | --- | --- |
| `src/worker/turns.ts` | `src/cf/account/turns.js`, `turn-scheduler.js`, `turn-recovery.js`, `function-calls.js`, `tool-execution.js` | Lease-guarded attempts, thread-ordered queue, suspend while the extension runs a browser call, placeholder result swapped for the real one, steer placed through Pi's steering queue and merged in the journal commit, cancel, alarm recovery, retry of retryable model failures (all of it agent-core's since steps 1-3; the file is now this project's configuration of the core) |
| `src/worker/model.ts` | `src/cf/model-transport.js`, `src/pi/turn-runtime.js` | OpenRouter model definition, failure codes and the retryable set |
| `src/worker/context.ts` | `src/pi/observation-stubs.js`, `src/cf/account/turn-recovery.js` | Old observations shrink to receipts; unanswered tool calls are answered |
| `src/worker/prompt.ts` | `knowledge/core/agent-browser-core.md` | Observe / act / verify guidance, much shortened |
| `src/worker/index.ts` | `src/cf/index.js` (bootstrap, authenticate) | Account token `acct_<id>.<secret>` stored as a hash |
| `src/browser/cdp.ts` | `src/browser/cdp.js` | Per-tab serialization, command timeout, idle detach, detach handling |
| `src/browser/snapshot.ts` | `src/browser/ax.js`, `src/browser/agent/snapshot-filter.js` | AX projection, protected fields, semantic re-resolution of refs, name/value filter |
| `src/browser/executor.ts` | `src/browser/controls.js`, `src/browser/value.js` | Box-model center click, trusted CDP input, protected-input refusal |
| `scripts/check-secrets.ts` | X Gardener's secrets check | Names-only check of deployed Worker secrets |
| `scripts/smoke-chrome.ts` | X Gardener's extension acceptance script | Disposable headless Chrome, extension loaded over CDP |

The Worker serves **just-bash** 3.6.0 (`just-bash/browser`, https://github.com/vercel-labs/just-bash,
Apache-2.0, Copyright 2025 Vercel Inc.) bundled into the shell Worker of `run_code`'s bash runs
(`/sandbox/just-bash-<version>-<sha256>.js`, its license beside it as `/sandbox/just-bash-LICENSE.txt`
and named in the file's first line), with the packages its browser build imports (diff,
BSD-3-Clause; sprintf-js, BSD-3-Clause; turndown, MIT); it is used unmodified and is not part of
the extension package.

Later ports from X Gardener branch `fix-web-answer-delivery` (2026-10-08): the length-limit and
PDF-viewer lines in `src/worker/prompt.ts` (from `knowledge/system/system-prompt.md` and
`knowledge/core/agent-browser-core.md`); PDF-viewer input refusal and "a debugger detach on
arrival at the requested URL is a successful navigation" in `src/browser/executor.ts` (from
`src/browser/agent/executor.js` and `navigation-command.js`); the PDF read in `src/worker/pdf.ts`
(Workers AI `toMarkdown`, its `### Page N` headings turned into `--- page N ---` lines from the
URL's `#page=N`, a size-bounded public fetch whose every redirect is validated again) from
`src/reads/sources/papers.js` (`pdfMarkdown`, `pdfPages`), `src/reads/net.js` (`fetchPublic`)
and `src/cf/research/web-fetch.js` (`validatePublicUrl`, `readBoundedBytes`).

Ports in 0.1.3 from X Gardener branch `gardener-0.5` (commits `be32561` and `aabdb52`,
2026-10-08), rewritten in TypeScript and reduced to what this project's one `browser` tool needs:

| This project | Adapted from (X Gardener) | What was kept |
| --- | --- | --- |
| `src/browser/cdp.ts` (`iframeSessions`, per-API client state) | `src/browser/cdp.js` (`iframeSessions`, `connections`) | `Target.setAutoAttach` with flattened sessions filtered to iframes, nested auto-attach in each child session, session bookkeeping by attach/detach events, commands routed to `{tabId, sessionId}` |
| frame walk in `src/browser/executor.ts` (`snapshot`) | `src/browser/agent/snapshot-input.js`, `src/browser/frame.js` | Iframe AX node -> `DOM.describeNode` -> child `frameId` -> the session whose frame tree holds it; per-frame `Accessibility.getFullAXTree`; isolated worlds for iframe scripts; refs bound to their frame's document (here recursive, not one level) |
| scroll in `src/browser/executor.ts` | `src/browser/agent/scroll.js` | Scroll the document by script and read the position back; a wheel event remains for inner scrollers and the PDF viewer |
| `SELECT_OPTION` in `src/browser/executor.ts` | `src/browser/vendor/agent-browser/interaction-scripts.js` (`SELECT_OPTIONS`) | Match an option by value or text, report the available options, fire `change` (here one option, plus `input`) |

The frame lookup, the agent window and input focus (`createAgentTab`, `prepareInput`, from
`src/browser/agent-window.js` and `src/browser/input-focus.js`), the opened-tab watch (from
`src/browser/agent/popup-wait.js`) and the clickables discovery (from
`src/browser/vendor/agent-browser/snapshot-cursor.js`) were ported here in 0.1.3 as
`src/browser/frames.ts`, `tabs.ts` and `clickables.ts`; since 0.1.4 they are agent-core's (below).
The two agent-browser pieces are from [vercel-labs/agent-browser](https://github.com/vercel-labs/agent-browser)
v0.37.0 (`cli/src/native/snapshot.rs`, `cli/src/native/interaction.rs`), Apache-2.0, as vendored
by X Gardener; the license is in `src/browser/LICENSE-agent-browser` and the changes are noted at
each use. Not ported from X Gardener's browser layer: its Rust/WASM snapshot renderer, durable ref
ledger, evidence store and action receipts, batch/native command set, network/HAR/console capture,
frame selection command, hit-testing before clicks, paste/upload/drag, page feedback overlays,
observation, and everything X-specific; they depend on its contract and offscreen modules or have
no use with this project's single tool.

Simplified or dropped relative to X Gardener (as first ported; the session journal and compaction
are shared again since agent-core step 2, see below): thread
notes, the Rust/WASM snapshot renderer, durable cross-snapshot ref ledger, batch commands, action
proposals/receipts ledger, Routines, Reads, memory, connectors, code mode, X GraphQL and every
X-specific module, WebSocket account events (replaced by polling), R2 image archiving, provider
routing and fallbacks, and the monthly spend cap (replaced by a per-turn estimate).

## Shared core (0.1.4)

Since 0.1.4 the browser modules above that both projects need (`cdp`, `frames`, `tabs`,
`clickables`, the select, scroll and PDF-viewer pieces, plus the pre-click hit test X Gardener had
and this project had not ported) live in **agent-core**, shared with X Gardener; both projects run the same copy (since
the move into the X Gardener monorepo the package `packages/agent-core`, imported as
`agent-core`; before that a copy vendored into `vendor/agent-core/`). agent-core is MIT-licensed by the same
author; its `NOTICE.md` records the origin of each piece. What stays here is this project's own:
`src/browser/cdp.ts` (the CDP allowlist), `src/browser/snapshot.ts` (the snapshot text format) and
`src/browser/executor.ts` (the one `browser` tool and its guards).

Since 0.1.5 long-term memory is agent-core's memory layer, also run by X Gardener: the
`memories` store, the rule for which saves need the user's update permission, the confirmed
instructions added to the prompt, page-guide selection, and the compaction policy (thresholds,
token estimate, history text for the summarizer). This project's own parts are
`src/worker/memory-tools.ts` (its tool schemas and the per-message permission),
`src/worker/compaction.ts` (where the summary is stored and used; agent-core since step 4) and the prose in
`src/worker/prompt.ts` (adapted from X Gardener `contract/agent-tools.js`,
`knowledge/system/account-instructions.json` and `src/cf/summary-model.js`). The page guides in
`src/worker/page-guides.ts` are generated from X Gardener `knowledge/domains` (arXiv's advanced
search, X's pages and X's article editor) by the monorepo's `tooling/knowledge/build.mjs`.

Also since 0.1.5, three runtime pieces come from agent-core's runtime layer: the durable turn
budget (X Gardener's, with this project's ceilings and per-turn spend estimate), model failure
codes and the retry rule (X Gardener's rules plus this project's reading of HTTP status and
timeouts), and the final-answer checks this project wrote (tool-call markup, length limits),
which X Gardener now runs too.

Since the monorepo's agent-core step 1 (after 0.1.6), the durable turn queue is agent-core's
too, extracted from X Gardener: the turn, step, browser-call, tool-receipt and idempotency tables
(`RUNTIME_SCHEMA`, replacing this project's `turns`, `browser_calls`, `events` and `tool_effects`),
claim and leases, scheduling, the browser-call claim and settlement with its function-result
receipt, memory-tool receipts and recovery.

Since agent-core step 2, the attempt runs on agent-core's Pi layer, extracted from X Gardener: a
`pi-coding-agent` session over the branch journal (`pi_journal_entries`, replacing this project's
flat `journal` and its `compactions` table), Pi's native compaction with this project's summary
request, steer placement and merge (agent-core `takeSteer`/`mergeSteer`), the turn budget's
last-step notice, the announced-action check, and tool-call markup stripping.
Since agent-core step 3, the turn itself runs on agent-core's turn driver (`runTurnAttempt`,
`cancelTurn`, the thread restore and the recovery of a lost attempt's calls), extracted from X
Gardener's `src/cf/account/turns.js`; this project's own attempt runner, suspend/finish/fail
code, call re-queuing and cancel-time journal rewrite are gone, and it adopts Gardener's rules (a
call lost before it was queued is reported as not started, a cancelled call is read from its row
when the thread continues, one retry of a retryable model failure, the step and spend stops).
`src/worker/turns.ts` is this project's TurnHost and keeps its browser tool, tab context, page
guides, answer checks (plain prose, length limit), partial text and spend estimate.
Since agent-core step 4, more of what this project wrote moved into agent-core, where X Gardener
may use it too: the answer-repair requests (`answerRepairPolicy`), the summary request of Pi's
compaction (`streamedSummary`, replacing `src/worker/compaction.ts`), the model request lifecycle
around a stream (`reportModelRequests`) and the per-turn spend ceiling (`createTurnBudget`'s
`maxCostUsd`, replacing `src/worker/budget.ts`); and this project now uses X Gardener's turn page,
manual retry and ids (replacing `src/worker/ids.ts`); `budget.ts`, `ids.ts` and `compaction.ts`
are gone, and the tables above list only files that still exist.
Since agent-core step 5, the side panel is agent-core's chat UI (`agent-core/ui`, X Gardener's
React chat moved into the core) with this project's slots and shell; the hand-built DOM panel
(`src/ext/panel.ts`) is gone, and a turn's view is agent-core's turn projection (`projectTurn`).
Since agent-core step 6, the PDF read this project wrote (the public fetch, its caps, the
conversion, the page markers and the cache interface) is agent-core's `readPdf`, which X Gardener
also runs for its browser read of a PDF (`src/worker/pdf.ts` keeps the route's mapping, the
deployment's converter and the account cache); the memory tools run agent-core's memory-tool
envelope, as X Gardener's do; X Gardener adopted the answer repairs; and deleting a thread
archives it by X Gardener's convention (`agent_threads` status and `archived_at`).

The product shape (side panel, per-message tab context, explicit `tabId` on every call, a single
`browser` tool with an action enum, hard refusal on human-verification pages) follows notes on
[FibonaAI/tabgent](https://github.com/FibonaAI/tabgent); no Tabgent code was copied.

Runtime dependencies: `@earendil-works/pi-coding-agent` and `@earendil-works/pi-ai` (MIT), bundled
into the Worker (`scripts/prepare-pi.ts` stages Pi for the bundle through agent-core's shared
Worker build, as X Gardener's `tooling/worker/prepare-pi.mjs` does). The extension bundles React and React DOM (MIT) and marked
(MIT), for the shared chat UI.

The extension icons (`src/ext/icons/`) are rendered from the pi logo (https://pi.dev/logo-auto.svg),
cropped to its marks; the logo belongs to the pi project.
