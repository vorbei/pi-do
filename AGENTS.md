# Agent rules

## Boundaries

- Two runtimes, one contract: the Worker (`src/worker/`) and the extension (`src/ext/`, `src/browser/`) share shapes only through `src/shared/protocol.ts`. A wire change updates that file and its tests first.
- Every deployment input is a named constant in `src/config.ts`. `wrangler.jsonc` is generated from it (`npm run wrangler:config`); never edit it by hand.
- Never commit secret values, Cloudflare account ids, API tokens, cookies or real user data. Secrets are declared by name in `REQUIRED_SECRETS` and set with `wrangler secret put`; local values live in the gitignored `.dev.vars`.
- No credentials leave the browser. The extension never reads cookies, storage or passwords; `src/browser/cdp.ts` sends only the CDP methods on its allowlist. Typing into password, one-time-code or payment fields is refused.
- An action that commits something outside the browser session (send, post, submit, buy, delete) must pass `confirmationReason` in `src/shared/protocol.ts` and an explicit user approval in the side panel, in a Routine run too (never approved for the user). A Routine run without `write` makes no page action at all (`ACTING_ACTIONS`). Do not move these rules into the prompt.
- Model-facing prose lives only in `src/worker/prompt.ts`, which takes the rules X Gardener sends too from `agent-core/guidance`, and in `src/worker/page-guides.ts`, the page guides the monorepo's knowledge build generates from X Gardener's `knowledge/domains` (edit them there, never by hand here).
- This package is `packages/pi-do` in the X Gardener monorepo: pi-do is a split and simplification of X Gardener (the same implementations with X removed or off; Routines run on agent-core's engine and editor), not a rewrite. Import nothing from Gardener (`src/`, `contract/`, `knowledge/` at the repository root) and nothing site-specific; what both products need moves into `packages/agent-core`. `NOTICE.md` records what was adapted from where.
- agent-core (`packages/agent-core`) is the core this project shares with X Gardener (browser executor, memory, runtime pieces), imported only as the `agent-core` package (`agent-core/<layer>`), never by path. Change it there, in the same commit as what pi-do and Gardener need, and run the X Gardener monorepo's local gate (it runs this package's `check` too). What pi-do decides (its CDP allowlist, its prompt, the page guides it shows) stays in `src/`.
- The Worker deploys with this package's own `wrangler.jsonc`, never X Gardener's Worker config. A standalone pi-do repository is a one-way mirror of this directory in the X Gardener monorepo; never change it there.
- Give each source file one role that can be stated in one sentence. No pass-through layers.

## Verification

- `npm run check` (typecheck, unit tests, generated-config check, extension build) before handing off code.
- A change to the turn runtime, the browser executor or the panel also runs `npm run smoke:chrome` (local Worker, fake model, headless Chrome for Testing; no network services).
- Tests exercise observable behavior through module interfaces: turn outcomes, journal contents, CDP commands sent, results returned. Do not pin prompt sentences or file layout.
- A bug reproduced in real Chrome becomes a smoke or unit case before it is closed.

## Records

- Before a release: bump `VERSION` in `src/config.ts` and `package.json` together, regenerate `wrangler.jsonc`, run the checks and the smoke, then tag `vX.Y.Z`.
