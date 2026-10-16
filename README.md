# pi-do-browser-ext

A Chrome side-panel browser agent. You chat in the side panel; the agent loop runs on
[Pi](https://www.npmjs.com/package/@earendil-works/pi-coding-agent) inside a Cloudflare Durable
Object; browser actions run locally in your Chrome through `chrome.debugger` (CDP).

Status: an early preview (the version is in `package.json`). Use it on pages you are comfortable letting an agent read.

## How it works

```
 Chrome                                   Cloudflare                       OpenRouter
 ┌──────────────────────────────┐   HTTPS  ┌─────────────────────────────┐  HTTPS ┌───────────┐
 │ Side panel (src/ext)         │ ───────▶ │ Worker (src/worker/index)   │        │           │
 │  chat, status, cancel, steer │  poll    │  bearer-token auth          │        │  model    │
 │  confirmation card           │ ◀─────── │        │ RPC                 │        │           │
 │  browser work loop ──┐       │          │ AccountDO (one per account) │ ─────▶ │           │
 │                      ▼       │  claim / │  Pi session (turns.ts)      │ ◀───── │           │
 │ executor (src/browser)       │ complete │  SQLite: agent-core turn    │        └───────────┘
 │  CDP: snapshot, click, type  │ ◀──────▶ │  queue tables, Pi journal   │
 └──────────────────────────────┘          └─────────────────────────────┘
```

1. You send a message. The panel adds the current tab's id, URL and title, and the Worker
   queues a turn in your account's Durable Object.
2. The Durable Object runs a Pi session (agent-core's attempt) with one `browser` tool. When the model calls it,
   the call is stored as a row, the turn is suspended (`waiting_for_browser`), and its journal holds
   a placeholder result.
3. The open side panel claims the call (the claim waits on the Worker until the model makes one),
   runs it in your Chrome, and posts the result. The placeholder is replaced by the real result
   and the turn resumes.
4. The conversation is Pi's session journal, stored in SQLite as each user message, tool call and
   tool result ends, under a lease (agent-core's branch journal, the same as X Gardener's). If the
   Durable Object is evicted mid-turn, an alarm reclaims the turn and it continues from the
   journal; a browser call is never replayed.
5. Sending a message while a turn runs **steers** it: the running turn picks the message up at
   its next step. **Cancel** stops the turn and fails its pending browser calls. The thread's
   latest turn, once failed or cancelled, can be **retried** (its **Retry** button;
   `POST /api/turns/<id>/retry` with an `idempotencyKey`): the same turn runs again on its journal
   with another turn budget.
   An image pasted into the message box or dropped on it is attached to the message (at most
   four, each downscaled to 1568 px and re-encoded as PNG or JPEG in the panel; GIFs are refused).
   The Worker keeps them with the turn in its SQLite (`turn_images`), the model gets them in the
   message's user content, and the panel loads them again with `GET /api/turns/<id>/images/<n>`.
   A turn whose message carries images runs on the vision model (`VISION_MODEL_NAME` in
   `src/config.ts`, `openai/gpt-6.1-sol`, with medium reasoning effort); other turns run on `MODEL_NAME`,
   except a request answering a tool result with an image (a screenshot) or the vision model's own
   `run_code`: that one goes to the vision model, and `MODEL_NAME` sees the picture as a stub
   (agent-core `routeVisionRequests`).
6. The panel is agent-core's chat UI, the same React chat as X Gardener's: a thread list
   (**Chats**: `GET /api/threads`, the threads with a message, newest activity first, each titled by
   its first message; **New chat** starts one; deleting one, `DELETE /api/threads/<id>`, archives
   it as X Gardener does: it leaves the list and takes no new message, its turns stay and nothing it
   did is undone), Markdown answers (the answer so far while the model
   writes it), each turn's steps under "How it worked", Stop, Retry, Edit and older messages a page
   at a time (`GET /api/threads/<id>/turns?before=`), in agent-core's panel shell, the same as X
   Gardener's: one header with **Chat** (the thread list) at the top left and **⋯** (Settings: the
   Worker connection, **Where Pi works**, the **Memory updates** switch and the Memory view) at the right, the
   conversation filling the panel and the message box pinned at the bottom. pi-do adds the tab
   picker above the message box (the current tab by default, one of the window's web tabs, or
   **No tab**; the choice is the tab context sent with each message) and the confirmation card.
7. The panel polls its turns every second and holds browser-call claims open only while a turn
   is not finished. Idle, it polls once a minute while visible (at most 1,440 requests, 2,880
   Durable Object requests a day) and not at all while hidden; sending, focusing or showing the
   panel refreshes at once.

### Browser tool

One tool, one action per call, an explicit `tabId` on every page action:

| action | does |
| --- | --- |
| `tabs` | list open http(s) tabs |
| `open {url}` / `select_tab {tabId}` / `navigate {tabId,url}` | tab management; `open` puts the tab in the agent's own unfocused window, or with **This window** behind your current tab in the panel's window |
| `snapshot {tabId, interactive?, filter?}` | accessibility tree with refs (`e12`) for controls, each iframe's tree (cross-process ones included) under its `- iframe` line, and `clickable` refs for elements without a control role that take clicks (cursor:pointer, onclick, tabindex) |
| `click {tabId,ref}` / `type {tabId,ref,text,submit?}` / `press {tabId,key}` / `scroll {tabId,direction}` | input through trusted CDP events, in whichever frame the ref is; a click or press reports the tabs it opened |
| `select {tabId,ref,option}` | chooses an option of a native `<select>` by value or visible text |
| `read_text {tabId,maxChars?}` | page text, then each iframe's text under a `--- iframe <url> ---` line; on a PDF tab, the PDF's text with a `--- page N ---` line per page, from page N when the URL ends in `#page=N` |
| `screenshot {tabId}` | JPEG of the visible viewport |

### Memory

The agent keeps long-term memory across your chats (per account, in its Durable Object), with
three tools: `search_memory`, `remember` (a fact, an event, or a standing instruction) and
`forget_memory`. A standing instruction the agent saves applies only after you **Confirm** it in
Settings → Memory, which also lists the saved facts and events; you can remove any of them there.
Saving facts and events, and replacing or forgetting memories, needs the **Memory updates** switch
in Settings (the "…" menu; on by default, sent with each message; a message from an older panel
that states no permission gets none); without it only a new instruction can be saved, still waiting for
your confirmation. A message sent while a turn runs under another memory setting is not merged
into that turn: it runs as its own turn after it. The agent cannot forget an instruction you
confirmed; only you can, in Memory.

### Web search and fetch

`web_search` and `web_fetch` read the public web from the Worker, without a tab: a search returns
untrusted snippets with their source URLs (OpenRouter's web search with the same
`OPENROUTER_API_KEY`, then Tavily and Brave when their keys are set), and a fetch returns one public
page's readable text (Mozilla Readability; HTTP(S) only, no private or local hosts, checked again on
every redirect, 256 KiB of HTML, 20 s). Both are agent-core's web layer, which X Gardener runs too.
A billed search's cost counts in the turn's spend ceiling. Pages that need your login, interaction
or rendering still go through the browser.

### Code

`run_code` runs code the model writes in your browser, not on the Worker: JavaScript (the body of
an async function) or a bash script in [just-bash](https://github.com/vercel-labs/just-bash)'s
in-memory shell (grep, sed, awk, sort, uniq, jq, yq, xan ...), with optional text files the run
starts with. It is pure computation on the data the model puts in the code or its files
(arithmetic, parsing, data transforms, searching or enumerating cases). The Worker queues it like a
browser action, so it runs only while the side panel is open; the panel runs it in agent-core's
code sandbox: a sandboxed extension page (an opaque origin with no extension API, cookies or
storage, under a CSP with `connect-src 'none'`) that starts a fresh Worker per run, which also has
fetch, XHR, WebSocket, importScripts, storage and `chrome` removed. A run's Worker is terminated
after 10 s (`RUN_CODE_LIMITS` in `src/shared/protocol.ts`), so a busy loop ends as `EXEC_TIMEOUT`;
a run returns at most 8,000 characters of value or stdout plus its console lines or stderr, and a
turn may run code 6 times. The call shows in the turn's "How it worked".

just-bash is not in the extension. The Worker serves the shell Worker of bash runs (agent-core's
runtime with just-bash, about 1.3 MB, 353 KiB gzipped) as a Workers Static Asset at
`/sandbox/just-bash-<version>-<sha256>.js` (`SANDBOX_ASSETS_DIR`, written by
`scripts/build-sandbox.ts` in the Worker build; immutable, CORS `*`). The extension build pins
that file's version and SHA-256. On the first bash run the panel downloads it from the connected
Worker, refuses it unless its SHA-256 is the pinned one (`SANDBOX_SOURCE_MISMATCH`; an unreachable
file is `SANDBOX_SOURCE_UNAVAILABLE`), keeps it in its Cache API under the hash, and hands the text
to the sandboxed page, which starts the run's Worker from it. JavaScript runs use the extension's
own small Worker and never download it. The extension and the Worker must come from the same
build: an extension pinned to another build gets `SANDBOX_SOURCE_UNAVAILABLE` (HTTP 404) for bash.

A long chat is summarized once its context passes a threshold (`CONTEXT_COMPACTION` in
`src/config.ts`; Pi's own compaction, measured on what the model reports, system prompt and tools
included): the older part becomes one summary in the journal, the recent part stays as is.

Page guides (`PAGE_GUIDES` in `src/worker/page-guides.ts`, generated by the monorepo's knowledge
build from X Gardener's `knowledge/domains`) add a short verified note to the first browser result
on a matching page in a turn, for example how arXiv's advanced-search date filter treats papers
revised in a later year, or how X's post cards, virtualized timelines and toggles behave (on any
x.com page; a page's own guide, such as X's article editor, wins over the site-wide one).

### Routines

**Routine** in the "…" menu lists your Routines: a name, instructions, and a schedule (weekdays and a
time in your time zone, or the cron they make, with an optional random start window). Each run
is a new chat whose first message is the instructions, about no tab in particular; it appears in
the Chat list under the Routine's name with what started it (`Scheduled run`, `Manual run`), and
the Routine's editor lists its runs. **Run now** starts one run with switches that start off.

- A run only reads pages unless the Routine allows **Act in the browser**; a read-only run's
  click, type, select or press is refused before anything is sent (`ACTING_ACTIONS`). With it, an
  action that sends, posts, buys or deletes still waits for **Allow once** in the side panel, as in
  a chat: nothing is approved for you, and an unanswered card declines after four minutes.
- **Update memory** lets a run save and change memories, like the Memory updates switch.
- A run needs this side panel open. While a Routine is on a schedule, an open, visible panel looks
  for browser calls once a minute; a scheduled run that finds no panel seen within two minutes is
  recorded as `CHROME_OFFLINE` at once, without a model call, and is not retried when the panel
  comes back. A run's call no panel picks up within two minutes also fails it with
  `CHROME_OFFLINE`. One run of a Routine at a time; a slot that finds one still running is skipped.
- A run is started by hand from the Routine's editor (**Run now**); a list row only opens it.

The schedule, its alarm (the Durable Object's one alarm, as a job queue), the run threads and the
editor are agent-core's (`agent-core/routine`, `agent-core/ui/routines`), the same as X Gardener's
Routines; `src/worker/routines.ts` binds them.

### Shared core

The browser executor, the memory store, page-guide selection, the compaction policy and its
summary request, the turn budget with the per-turn spend ceiling, model failure codes, the
final-answer checks and their repair requests, the durable turn queue (scheduling, executor calls,
receipts, recovery, steers, cancel, retry, the turn page and the turn projection), the turn driver
and the Pi session with its journal (`agent-core/pi`) and the side panel's chat (`agent-core/ui`) are
**agent-core**, shared with X Gardener (see `NOTICE.md`). What remains in `src/worker` is
configuration and composition: the routes, the Durable Object's wiring, the prompt text, the
browser tool and its results, the memory tools' per-message permission, the PDF read, the
progress items and thread list the panel shows, and the panel's own parts (the Settings view,
confirmation card, tab picker) in the shared panel shell around the shared chat. This package lives in the X Gardener
monorepo as `packages/pi-do`, next to `packages/agent-core`, and imports the core as the
`agent-core` package, a local `file:../agent-core` dependency (`agent-core/browser`, `agent-core/memory`, `agent-core/runtime`, `agent-core/pi`, `agent-core/ui`).
A core change is made in `packages/agent-core` and verified against both products by the
X Gardener monorepo's local gate. A standalone pi-do repository is a one-way mirror of
`packages/pi-do`; it builds with a checkout of the agent-core mirror beside it (see Develop).

### Safety

- **Confirmation seam.** Clicking a control named like send / post / submit / buy / pay / order /
  delete / sign up (and their Chinese equivalents; a `clickable` is named by its text), clicking a
  button inside a form, typing with `submit`, pressing Enter in a text field other than a search
  field, and pressing Enter or Space on a focused control that a click would ask about (focus
  inside an iframe is looked up there; unknown focus asks) all stop for an **Allow once / Decline**
  card in the side panel. The rule is code (`confirmationReason` in `src/shared/protocol.ts`),
  not a prompt instruction. A declined action returns `USER_DECLINED` to the model.
- **No credentials leave the browser.** The extension has no `cookies` permission and its CDP
  connection only sends allowlisted methods (no cookie, storage or network reads; iframe sessions
  come from `Target.setAutoAttach` on the tab's own attachment, iframe text is read in an isolated
  world). Password,
  one-time-code and payment fields are blanked in snapshots and refused for typing. The only
  credential sent to the Worker is this extension's own account token.
- **Hard refusals.** Only ordinary http(s), non-incognito tabs; no input on pages showing
  reCAPTCHA / hCaptcha / Turnstile challenges; no clicks, keys or typing on Chrome's PDF viewer
  (refused before anything is sent; scrolling is allowed); navigation only to http(s) URLs.
- **PDF text.** `read_text` on a PDF tab sends only the tab's URL to the Worker
  (`POST /api/pdf/text`; no cookies, no page content). The Worker fetches that URL itself, only if
  it is http(s) on a public host (every redirect is checked again), at most 30 MiB within 30 s, and
  converts it with Workers AI `toMarkdown`. A PDF behind a login, on your intranet or on
  `localhost` is therefore reported as `PDF_TEXT_UNAVAILABLE` with the reason, never fetched as
  you; a failed conversion gets the same code with a hint not to click the viewer. A signed PDF
  URL (one carrying an access token in its query) does reach the Worker, which does not log it.
  Each account caches its conversions in its Durable Object for 24 h (keyed by a SHA-256 of the
  URL, which is not stored; entries up to 1.5 MB, 20 MiB per account, least recently used dropped
  first; `PDF_CACHE`), so another page of the same PDF is not fetched again.
- **Pages.** Workers AI writes a PDF as metadata followed by a `### Page N` heading per page
  (observed output; Cloudflare does not document the layout). Each heading becomes a
  `--- page N ---` line, and a URL ending in `#page=N` starts the text at page N. If a conversion
  has no page headings, pages are not approximated: the whole text is returned as one block,
  `read_text` says it has no page boundaries, and `#page=N` is not applied.
- **The agent acts only while the panel is open.** The browser work loop lives in the panel page.
  A call nobody claims within 2 minutes fails its turn with `CHROME_OFFLINE`.
- **Tabs and focus.** By default, tabs the agent opens go to one normal, unfocused window of its
  own, so your window, tab and focus stay as they are. With **Where Pi works: This window** in
  Settings (stored in the extension, read at each `open`), they open in the side panel's window
  instead, right after the tab you are on (that tab is their opener) and in the background: opening
  or reading a page never switches the tab you are looking at. Before a click, key, typing or
  scroll, a background tab is brought to the front of its window (Chrome throttles hidden tabs;
  input to them lagged seconds) and the page gets CDP focus emulation; the window itself is never
  focused. So in This window you watch the agent act, and `select_tab` shows a tab on request.
  Actions on tabs you already have happen in place in either mode; nothing is moved or copied.
- **Budgets.** Each turn has at most 30 model requests (the last tool step without tools, so it
  ends with an answer, and one request held back for an answer check), 60 tool calls (6 of them
  `run_code`) and an
  estimated USD 0.50, persisted across resumes.
- **Answer checks.** The final answer is checked in code: tool-call markup a model printed as text
  is removed, and if nothing is left one tools-off request asks for a prose answer; an answer
  longer than an explicit limit in your message ("under 130 words", "200 字以内", "at most 280
  characters") gets one tools-off rewrite request. Each check asks at most once per turn.

## Error codes and logs

The codes and lifecycle log names are X Gardener's (agent-core's), so one reading serves both.

**A turn's `errorCode`** (in its view; the turn is `failed` unless noted):

| code | meaning |
| --- | --- |
| `TURN_CANCELLED` | the user cancelled it (`cancelled`) |
| `CHROME_OFFLINE` | no extension claimed its browser call within 2 minutes |
| `MODEL_STEP_LIMIT` | its 30 model requests ran out before an answer |
| `MODEL_SPEND_LIMIT` | its estimated USD ceiling was reached before a model request |
| `MODEL_OUTPUT_EMPTY` | the model gave no final answer (retried once) |
| `MODEL_HTTP_<status>`, `MODEL_TIMEOUT`, `MODEL_UNAVAILABLE` | the model request failed; a retryable one (429, 5xx, 408, 409, 425, timeout) is retried once after a delay, during which the turn is `queued` with the code |
| `MODEL_API_KEY_MISSING`, `MODEL_FAILED`, `MODEL_<CODE>` | another model or runtime failure |
| `CONTEXT_OVERFLOW`, `CONTEXT_COMPACTION_<…>` | the history no longer fits and could not be summarized |

**A browser call's error**, which the model reads as the call's result (the turn goes on):
`BROWSER_FUNCTION_TIMEOUT` (a read not reported in time), `EFFECT_UNKNOWN` (an action not reported
in time: observe before acting again), `CHROME_OFFLINE`, `TURN_CANCELLED`, and the extension's own
codes (`USER_DECLINED`, `REF_STALE`, `TAB_NOT_FOUND`, `PDF_TEXT_UNAVAILABLE`, …). A tool call an
interrupted attempt never started is `TOOL_NOT_STARTED` (the model may ask again); one whose effect
is unknown is `TOOL_EXECUTION_INTERRUPTED`.

**A request's error** (`{ "error": "<CODE>" }`, HTTP 400 unless noted): `UNAUTHORIZED` (401),
`NOT_FOUND` (404), `INTERNAL_ERROR` (500), `INVALID_JSON`, `BODY_TOO_LARGE`, `BOOTSTRAP_DISABLED`,
`ACCOUNT_NOT_BOOTSTRAPPED`, `INVALID_TURN_INPUT`, `INVALID_CONTEXT`, `INVALID_IDEMPOTENCY_KEY`,
`IDEMPOTENCY_CONFLICT`, `TURN_NOT_FOUND`, `AGENT_TURN_NOT_FOUND` (a page anchor of another
thread), `TURN_NOT_RETRYABLE`, `TURN_RETRY_NOT_LATEST`, `TURN_RETRY_PENDING_CALLS`, `AGENT_THREAD_NOT_FOUND`,
`AGENT_THREAD_BUSY` (deleting a thread with an unfinished turn), `AGENT_THREAD_NOT_ACTIVE` (a message
to a deleted thread),
`FUNCTION_CALL_LEASE_INVALID` (an unknown call or a stale claim), `FUNCTION_RESULT_CONFLICT`,
`INVALID_RESULT`.

**Lifecycle logs** (one JSON line each in the Worker's log; ids, counts and codes, never what the
user or a page wrote): `agent.turn.queued`, `.claimed`, `.budget`, `.checkpoint`,
`.waiting_for_function`, `.completed`, `.failed`, `.retrying`, `.cancelled`, `.manual_retry`,
`.premature_answer_discarded`, `.recovery_started`, `.browser_unavailable`; `agent.thread.archived`;
`agent.function.created`, `.claimed`, `.completed`, `.failed`, `.exhausted`; `agent.tool.recovered`,
`.deduplicated`, `.unresolved`; `model.started`, `.completed` (with the request's `costUsd`
estimate), `.failed`, `.cancelled`; `agent.context_compacted` (`outcome` completed, failed or
deferred); `agent.output.tool_markup_stripped`, `agent.output.answer_repair` (`plain` or
`length`), `agent.output.pending_action_steer`; `request.failed` (an unexpected request error).

## Layout

```
src/config.ts            every deployment input: Worker and DO names, the Workers AI binding
                         (AI_BINDING), compatibility, model, secret and var names, turn budgets,
                         PDF read limits (PDF_READ), leases and timeouts
src/shared/protocol.ts   wire contract: browser, run_code and web tool args, results, confirmation rule, turn, thread and Routine views
src/worker/index.ts      HTTP routes, CORS, bootstrap, bearer auth
src/worker/account-do.ts the Durable Object: auth + RPC into the turn runtime and Routines, alarm
src/worker/routines.ts   configuration of agent-core's Routine engine: the RoutineHost, the alarm's jobs
src/worker/turns.ts      configuration of agent-core's runtime: the TurnHost, the browser tool and its
                         results, the attempt's options, the turn requests, the panel's turn and
                         thread views
src/worker/memory-tools.ts the model's memory tools over agent-core's store, per-message permission
src/worker/code-tool.ts  the model's run_code: queued for the extension, what the model reads of a run
src/worker/web-tools.ts  the model's web_search and web_fetch: agent-core's web layer in the Worker
src/worker/memory-view.ts the Memory view's reads and the user's confirm / remove
src/worker/pdf.ts        PDF URL -> public fetch -> Workers AI toMarkdown -> --- page N --- text
src/worker/context.ts    the model view's stub of old browser observations
src/worker/{model,prompt,schema}.ts  the OpenRouter model, all model-facing prose, the DO schema
src/worker/pdf-cache.ts  the account's bounded cache of PDF conversions (DO SQLite)
src/browser/cdp.ts       pi-do's CDP allowlist over agent-core's chrome.debugger connection
src/browser/snapshot.ts  AX trees of all frames -> text with refs, filter, ref re-resolution (pure)
src/browser/executor.ts  runs one browser call, with the hard guards
src/ext/panel.tsx        the side panel: agent-core's chat with pi-do's slots, the work loop
src/ext/work-loop.ts     claims one executor call: a browser action (executor.ts) or a code run (the code sandbox)
src/ext/code-sandbox.ts  the sandboxed page: agent-core's code sandbox page over the bundled code Worker
src/ext/code-worker.ts   the shipped code Worker: agent-core's runtime for JavaScript runs
src/ext/code-shell-worker.ts the shell Worker of bash runs (just-bash), served by the Worker, pinned by hash
scripts/build-sandbox.ts builds the shell Worker, its hash and the static assets the Worker serves
src/ext/chat-client.ts   the chat's client over the Worker API (polling, the selected thread)
src/ext/routine-client.ts the Routine view's client over the Worker API
src/ext/settings.tsx     Settings: connect, disconnect, the Memory view
src/ext/                 also the MV3 manifest, panel HTML/CSS, API client, poll schedule, work loop
scripts/                 build, wrangler config generator, secret check, Chrome smoke
test/                    unit tests (vitest) and fixtures
```

## Requirements

- Node.js 22.18 or newer (scripts are TypeScript run by Node's type stripping), npm.
- Chrome 125 or newer for the extension (`chrome.debugger` child sessions, for iframes).
- A Cloudflare account and an OpenRouter API key to deploy (below).

## Develop

pi-do depends on agent-core as `file:../agent-core`, so a checkout of this repository needs the
agent-core repository cloned next to it, under the name `agent-core`, with its own install: the
Worker build bundles agent-core's files from that checkout, so their imports (`linkedom`,
`@mozilla/readability`) resolve from `agent-core/node_modules`. Both public repositories are
one-way mirrors of the same monorepo commit; use agent-core's `main` with pi-do's `main`.

```sh
git clone https://github.com/vorbei/agent-core.git
git clone https://github.com/vorbei/pi-do.git
(cd agent-core && npm install)
cd pi-do && npm ci
```

In the X Gardener monorepo instead, install once at the monorepo root: `npm ci` there installs Gardener and, as its `postinstall`,
runs `npm ci` here (this package keeps its own `package-lock.json` and `node_modules`, and links
`agent-core` from `../agent-core`). Every command below runs in `packages/pi-do`, or from the root
as `npm --prefix packages/pi-do run <script>`.

```sh
cp .dev.vars.example .dev.vars        # put a real OpenRouter key and any bootstrap secret in it
npm run dev                           # wrangler dev on http://localhost:8787 (PDF reads: see below)
npm run build:extension               # dist/extension and dist/pi-do-browser-ext-extension-<version>.zip
```

Load the extension: `chrome://extensions` → Developer mode → **Load unpacked** →
`dist/extension`. Click the toolbar icon to open the side panel, open **Settings**, enter the
Worker URL (`http://localhost:8787` locally) and the bootstrap secret, then **Connect**.

Workers AI has no local simulation: with the `ai` binding in `wrangler.jsonc`, `wrangler dev`
sends `toMarkdown` calls to your Cloudflare account (it needs `wrangler login` or the account
variables below, and usage counts against the account).

Checks:

```sh
npm run check          # typecheck, unit tests, wrangler.jsonc freshness, extension build
npm run smoke:chrome   # end-to-end in headless Chrome for Testing (needs the extension built)
```

The smoke runs everything locally: a fixture page server, `wrangler dev` with a scripted fake
OpenAI-compatible model (`MODEL_BASE_URL` points at it), and a disposable Chrome profile with the
extension loaded over CDP. It checks bootstrap, snapshot → click by ref → verify, and that a
"Send message" click waits for **Allow once** before the form is submitted, and on a local PDF
that `read_text` starts at `#page=N` with page markers, a click is refused unsent, a
navigation survives the PDF viewer's debugger detach and a re-read comes from the conversion cache.
It also checks a page with a same-origin iframe and a cross-site iframe (a second local server
reached as `localhost`, so Chrome puts it in another process) holding a button in a closed shadow
root and a nested iframe: one snapshot has refs in all of them, and click and type land there. A
custom dropdown (a `cursor:pointer` div) is opened through its `clickable` ref, a native select
is set with `select`, and a click that opens a new tab names it in its result. To stay offline the smoke runs `wrangler dev`
on a copy of the generated config without the `ai` binding and sets the test-only var
`PDF_TEST_CONVERTER_URL` to a local fake that answers in `toMarkdown`'s PDF layout; that var also
lets the Worker fetch the fixture PDF from `127.0.0.1`. Never set it on a deployed Worker (it is
ignored whenever the `ai` binding exists). Set
`CHROME_BINARY` if no Chrome for Testing is found (branded Chrome also works: the extension is
loaded with `Extensions.loadUnpacked` and `--enable-unsafe-extension-debugging`).

## Deploy to Cloudflare

### Cloudflare requirements

- **Plan.** Durable Objects with the SQLite storage backend (what this Worker uses,
  `new_sqlite_classes` in `wrangler.jsonc`) are available on both Workers Free and Workers Paid.
  **Workers Paid is recommended**: the Free plan limits each invocation to 10 ms of CPU and
  50 subrequests, and one agent turn makes up to 30 model requests and parses their streams.
  The upload is about 2.6 MiB (about 0.69 MiB gzipped, measured 2026-10-11: the Worker plus Pi's
  staged resources, with the web tools' page reader, Mozilla Readability and linkedom, about
  0.12 MiB of it; the 0.1.6 deploy was 9 MiB, 2.6 MiB gzipped, before agent-core's Worker build
  stubbed the parts of Pi a Worker never runs). Both plans' limits (3 MiB gzipped on Free, 10 MiB
  on Paid) are far off; `npm run worker:size` (part of `check`) fails above 800 KiB gzipped.
- **Workers AI** (PDF text). `wrangler.jsonc` binds Workers AI as `env.AI` (`AI_BINDING` in
  `src/config.ts`); the Worker uses only its `toMarkdown` method, to convert the PDF a
  `read_text` targets. Facts from Cloudflare's docs (checked 2026-10-08):
  - Workers AI is included in both the Free and Paid Workers plans
    ([pricing](https://developers.cloudflare.com/workers-ai/platform/pricing/)), and PDF is a
    supported `toMarkdown` format ([supported formats](https://developers.cloudflare.com/workers-ai/features/markdown-conversion/supported-formats/)).
  - "`toMarkdown` is free for most format conversions"; only conversions that run models, such as
    images (object detection and an image-to-text model), may cost Neurons beyond the free
    allocation of 10,000 Neurons per day ([Markdown Conversion](https://developers.cloudflare.com/workers-ai/features/markdown-conversion/#pricing),
    [how it works](https://developers.cloudflare.com/workers-ai/features/markdown-conversion/how-it-works/)).
    A PDF is converted by extracting each page's text (semantically when it carries a PDF/UA
    structure tree), with no model, so this Worker's PDF reads are expected to be free.
  - The docs state no file-size or page limit for `toMarkdown`, and the Workers AI
    [limits](https://developers.cloudflare.com/workers-ai/platform/limits/) page lists none for it.
    The 30 MiB cap and 30 s fetch timeout are this project's own (`PDF_READ`).
  - There is no local simulation of Workers AI: `wrangler dev` calls the real service
    ([development and testing](https://developers.cloudflare.com/workers/development-testing/)).
- **workers.dev subdomain.** The Worker is served on `https://pi-do-browser-ext.<your-subdomain>.workers.dev`
  (`workers_dev: true`). The account needs a workers.dev subdomain (created once in the dashboard).
  No custom domain or route is configured, so no zone permissions are needed.
- **API token permissions** (Account scope, for your account only):
  - `Workers Scripts: Edit` — upload the Worker, its Durable Object class and migration, and its secrets.
  - `Account Settings: Read` — wrangler reads account details.
  - `Workers Tail: Read` — only if you use `wrangler tail`.
  - `Workers Routes: Edit` (Zone scope) — only if you later add a custom route or domain.
  No KV, R2, D1 or Queues permissions are needed: the only storage is the Durable Object's SQLite.
  The Workers AI binding needs no extra deploy permission in Cloudflare's docs: the
  [binding docs](https://developers.cloudflare.com/workers-ai/configuration/bindings/) only add
  `ai` to the Wrangler file, and the "Edit Cloudflare Workers" token
  [template](https://developers.cloudflare.com/fundamentals/api/reference/template/) has no Workers AI
  permission. `Workers AI: Read` and `Workers AI: Edit` are what the docs require for the Workers AI
  [REST API](https://developers.cloudflare.com/workers-ai/get-started/rest-api/); add them only if a
  deploy or a token-authenticated `wrangler dev` is refused for the binding. The 0.1.6 deploy
  (2026-10-09) uploaded the `ai` binding with an account-scoped Workers token and was not refused.
- **Tooling.** `wrangler` 4.148.0 (pinned in `package.json`; run through `npx`). The Cloudflare
  `cf` CLI is not required.
- **Compatibility.** `compatibility_date` `2026-09-05` with the `nodejs_compat` flag (the Pi
  packages use Node built-ins). Both are set in `src/config.ts`.

### Secrets and environment

| name | where | purpose |
| --- | --- | --- |
| `OPENROUTER_API_KEY` | Worker secret | OpenRouter key for every model request |
| `BOOTSTRAP_SECRET` | Worker secret | entered once in the extension to create an account; without it anyone could spend your key |
| `TAVILY_API_KEY`, `BRAVE_API_KEY` | optional Worker secrets | further `web_search` providers after OpenRouter's |
| `CLOUDFLARE_ACCOUNT_ID` | your shell only | which account wrangler deploys to (never committed) |
| `CLOUDFLARE_API_TOKEN` | your shell only | the API token above (never committed) |
| `MODEL_NAME`, `MODEL_BASE_URL` | optional Worker vars | override the default model (`deepseek/deepseek-v4.1-flash`, which reads images) or endpoint |
| `MODEL_IMAGE_INPUT` | optional Worker var | `false` for a text-only `MODEL_NAME`: screenshots reach it as a placeholder (messages with images run on `VISION_MODEL_NAME` either way) |
| `AI` | Worker binding (`wrangler.jsonc`) | Workers AI, for PDF text through `toMarkdown`; created by `wrangler deploy`, nothing to set |
| `PDF_TEST_CONVERTER_URL` | local smoke only | fake PDF converter for offline runs; never set on a deployed Worker |

### Commands

`npm run deploy` (in the monorepo, from its root: `npm run pi-do:deploy -- <flags>`) runs
`scripts/deploy.sh`:

```sh
export CLOUDFLARE_ACCOUNT_ID=<your account id>
export CLOUDFLARE_API_TOKEN=<token with the permissions above>
export OPENROUTER_API_KEY=<your OpenRouter key>   # only read with --set-secrets

npm run deploy -- --set-secrets      # first deploy: uploads the missing secrets with the Worker
npm run deploy                       # later deploys
npm run deploy -- --name my-pi-do    # another Worker name than WORKER_NAME in src/config.ts
npm run deploy -- --skip-check       # skip `npm run check`
```

The script, in order:

1. Refuses to start unless `CLOUDFLARE_ACCOUNT_ID` and `CLOUDFLARE_API_TOKEN` are set (it never
   prints them).
2. Regenerates `wrangler.jsonc` from `src/config.ts` and checks it.
3. Runs `npm run check`, unless `--skip-check`.
4. Checks the target Worker's secrets by name (`npm run check:secrets -- --name <worker>`). When one
   is missing it stops and prints the `wrangler secret put` commands, or, with `--set-secrets`,
   uploads the missing ones with the deploy (`wrangler deploy --secrets-file`, a temporary 0600
   file it deletes): `OPENROUTER_API_KEY` from the environment, `BOOTSTRAP_SECRET` from the
   environment, else from `.deploy/bootstrap-secret`, else generated with `openssl rand -hex 32`
   and stored there (0600; `.deploy/` is gitignored). Secrets already on the Worker are never
   replaced; rotate one with `npx wrangler secret put <NAME> --name <worker>`.
5. Deploys with the pinned wrangler, then prints the workers.dev URL, the version id and the
   `/api/health` answer.
6. Builds the extension with that URL prefilled in Settings
   (`npm run build:extension -- --worker-url <url>`) and prints the zip's path.

Then load `dist/extension` (or the zip) in Chrome, open **Settings**, and connect with the
bootstrap secret (whoever deployed shares it with each user; the extension does not store it).
## Limits of v0.1

- A single turn that browses a lot is bounded by shortening old observations first; Pi
  compacts within the turn only past the threshold.
- The agent only runs while the side panel is open; there is no background or scheduled work.
- No file uploads, drag, PDF text selection or highlighting, or
  multi-account isolation beyond one account per extension install. Scanned (image-only) PDFs
  have no text to read. A PDF the Worker cannot fetch by its URL (behind a login, on a private
  network, larger than 30 MiB) has no text either; the agent says so.
- The per-turn spend ceiling is an estimate from `DEFAULT_MODEL_COST`; update it with the model.

## 简体中文

一个 Chrome 侧边栏浏览器 agent：agent 循环用 Pi 跑在 Cloudflare Durable Object 里，浏览器操作通过
`chrome.debugger` 在你本地的 Chrome 中执行。发送、发布、提交、购买、删除等会改变外部状态的操作，
必须在侧边栏点 **Allow once** 确认后才会执行；扩展不读取 cookie 或密码，凭据不会离开浏览器。
部署需要 Cloudflare 账号（推荐 Workers Paid）、带 `Workers Scripts: Edit` 与 `Account Settings: Read`
权限的 API token，以及 `OPENROUTER_API_KEY`、`BOOTSTRAP_SECRET` 两个 Worker secret，命令见上文 Deploy 一节。
PDF 文字由 Worker 通过 Workers AI 绑定（`AI`，`toMarkdown`）转换：扩展只发送 PDF 的 URL，Worker
不带 cookie 自行抓取公开 URL，需要登录的 PDF 会返回 `PDF_TEXT_UNAVAILABLE`。

## License

MIT. See `LICENSE` and `NOTICE.md` (adapted code and its provenance).
