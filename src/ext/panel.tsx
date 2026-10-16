// The side panel: the shell (shell.ts: the shared header over the chat, the Routine view and
// Settings), agent-core's chat over pi-do's Worker (chat-client.ts) with pi-do's slots (the
// confirmation card, the tab picker, images pasted or dropped on the composer, a Routine run's
// mark), agent-core's Routine view over its Worker (routine-client.ts), the header status, and,
// while the panel is open and a turn is active, the work loop (browser actions and code runs), so
// the agent acts only while the user can see it.
import { createRoot } from "react-dom/client";
import { CODE_SANDBOX_PAGE, createCodeSandbox, loadPinnedSource } from "agent-core/browser";
import { mountChat, type ChatSlots } from "agent-core/ui";
import { createRoutineView, type RoutineSlots } from "agent-core/ui/routines";
import type { ConfirmRequest, ExecutorDeps } from "../browser/executor.ts";
import { MAX_TURN_IMAGE_BASE64, MAX_TURN_IMAGES, TURN_IMAGE_MAX_EDGE } from "../shared/protocol.ts";
import { ApiError, clearAccount, listRoutines, loadSettings, readPdfText, saveSettings, type Settings } from "./api.ts";
import { piDoChatClient } from "./chat-client.ts";
import { piDoRoutineClient } from "./routine-client.ts";
import { SettingsView } from "./settings.tsx";
import { mountShell, type PanelView } from "./shell.ts";
import { TabPicker, tabChoiceStore } from "./tab-picker.tsx";
import { runOneBrowserCall } from "./work-loop.ts";
import { ACTIVE_POLL_MS, IDLE_POLL_MS } from "./poll-schedule.ts";

// A claim waits this long on the Worker for the model's next browser call (long poll).
const CLAIM_WAIT_MS = 8_000;
const CONFIRM_TIMEOUT_MS = 4 * 60_000;

let settings: Partial<Settings> = {};
let view: PanelView = "chat";
let browserStatus = "";
// Whether the last response showed a turn that is not terminal; the work loop claims only then.
let turnsActive = false;
let wakeWork: (() => void) | null = null;
// Whether a Routine is on a schedule: then an idle, visible panel looks for a run's browser calls
// once a minute, so a scheduled run finds its browser while the panel is open.
let routinesScheduled = false;
let confirmation: { request: ConfirmRequest; answer(allowed: boolean): void } | null = null;

const ready = (): Settings | null => settings.workerUrl && settings.token ? settings as Settings : null;
const accountOf = (current: Settings | null) => current ? { accountId: current.token.split(".")[0] } : null;

// "This window" in Settings: the agent's new tabs open in the window this panel belongs to.
const deps: ExecutorDeps = { api: chrome, confirm: askUser,
  workWindow: async () => settings.workWindow === "this" ? (await chrome.windows.getCurrent()).id : undefined,
  pdfText: request => { const current = ready(); if (!current) throw new ApiError("NOT_CONNECTED", 0); return readPdfText(current, request); } };
// The model's run_code runs here, in agent-core's code sandbox: a sandboxed page embedded on the first
// run. A bash run's shell Worker (just-bash) is not shipped: it is loaded from the connected Worker
// on the first bash run and used only if its SHA-256 is the one this build pinned (then cached).
declare const PI_DO_SHELL_SANDBOX: { version: string; sha256: string; path: string };
const codeSandbox = createCodeSandbox({ document, url: chrome.runtime.getURL(CODE_SANDBOX_PAGE),
  shellSource: async () => {
    const current = ready();
    if (!current) throw new ApiError("NOT_CONNECTED", 0);
    return loadPinnedSource({ sha256: PI_DO_SHELL_SANDBOX.sha256, url: new URL(PI_DO_SHELL_SANDBOX.path, current.workerUrl).toString(),
      fetch: (input, init) => fetch(input, init), caches: globalThis.caches ?? null });
  } });

const tabs = tabChoiceStore(chrome.tabs);
const shell = mountShell(document.getElementById("panel")!, { version: chrome.runtime.getManifest().version, onView: show });

const client = piDoChatClient({
  settings: ready,
  tabContext: () => tabs.context(),
  onActivity(active) { turnsActive = active; if (active) wakeWork?.(); renderStatus(); },
  onUnauthorized: () => void disconnect(),
});

const TRIGGER_WORDS: Record<string, string> = { schedule: "Scheduled run", manual: "Manual run", retry: "Retried run" };

const slots: ChatSlots = {
  tray: () => confirmation && <ConfirmCard request={confirmation.request} onAnswer={confirmation.answer} />,
  // A Routine run is named by its Routine (the Worker's title) and marked by what started it.
  threadLabel: ({ thread }) => {
    const trigger = (thread as { parentThreadId?: string; trigger?: string });
    return trigger.parentThreadId ? { mark: <span className="chat-routine-pill is-scheduled">{TRIGGER_WORDS[trigger.trigger ?? ""] ?? "Routine run"}</span> } : null;
  },
  controls: () => <TabPicker store={tabs} api={chrome.tabs} />,
  // Images pasted into the message box or dropped on it, within the Worker's limits (protocol.ts).
  images: { max: MAX_TURN_IMAGES, maxEdge: TURN_IMAGE_MAX_EDGE, maxBase64: MAX_TURN_IMAGE_BASE64 },
  wording: {
    assistant: "Pi",
    placeholder: "Ask Pi about this page",
    welcome: "Ask about the current page or give the agent a task.",
    sendFailed: code => code === "MODEL_IMAGE_INPUT_UNSUPPORTED"
      ? "Not sent: the Worker's model cannot read images. Remove the images, or set an image-capable model on the Worker."
      : code || "Could not start this turn.",
    failure: turn => turn.status === "cancelled" ? "This turn was stopped. What already ran is kept above."
      : turn.errorCode === "MODEL_OUTPUT_LIMIT"
        ? "The model spent its whole output budget reasoning and gave no answer, also when asked again without tools. Retry, ask a narrower question, or set a model that reasons less on the Worker."
        : turn.errorCode === "MODEL_TIMEOUT" ? "The model did not answer within its time limit, also on a second try. Retry in a moment."
        : turn.errorCode === "MODEL_TURN_SPEND_LIMIT" ? "This turn reached its spend ceiling before it finished. What already ran is kept above; Retry gives it another allowance, or ask a narrower question."
        : "This turn did not finish.",
  },
};

const chat = mountChat(shell.chat, { client: () => client, slots, pageSize: 50, menu: shell.menu });

// The Routine view's parts: what a run may do in the browser, read-only unless allowed.
const routineSlots: Partial<RoutineSlots> = {
  permissions: [
    { name: "write", label: "Act in the browser", hint: "Click, type and choose on pages. An action that sends, posts, buys or deletes still asks you here first." },
    { name: "update", label: "Update memory", hint: "Save facts and events, and replace or forget memories." },
  ],
  defaultPermissions: { update: false, write: false },
  runNote: ({ write, update }) => `${write ? "This run may act in the browser; anything it would send or submit asks you here first." : "This run only reads pages and reports."}${update ? " It may also update memory." : ""}`,
  instructionsHint: "Each run starts from this text, as a message about no tab in particular. A run needs this side panel open.",
  emptyList: "No routines yet. A Routine runs a set of instructions on a schedule while this side panel is open, and only reads pages unless you allow it to act.",
  deleteNote: "Every future run stops and its history leaves these lists. Nothing a run already did is undone.",
};
const routinesView = createRoutineView({
  element: shell.routines,
  client: piDoRoutineClient({
    settings: ready,
    onList(list) { routinesScheduled = list.items.some(item => item.thread.schedule?.enabled); },
    onUnauthorized: () => void disconnect(),
  }),
  slots: routineSlots,
  onClose: () => show("chat"),
  // A run is a thread of the chat: it opens there.
  onOpenThread: ({ threadId }) => { show("chat"); chat.openThread(threadId); },
});
document.addEventListener("keydown", event => { if (event.key === "Escape" && view === "routines") routinesView.handleEscape(); });
const settingsRoot = createRoot(shell.settings);

async function init(): Promise<void> {
  settings = await loadSettings();
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== "local") return;
    for (const [key, change] of Object.entries(changes)) (settings as Record<string, unknown>)[key] = change.newValue;
  });
  show(ready() ? "chat" : "settings");
  setAccount();
  renderStatus();
  void workLoop();
}

async function connected(workerUrl: string, token: string): Promise<void> {
  settings = { ...settings, workerUrl, token };
  await saveSettings({ workerUrl, token });
  show("chat");
  setAccount();
  renderStatus();
}

async function disconnect(): Promise<void> {
  await clearAccount();
  settings.token = undefined;
  show("settings");
  setAccount();
  renderStatus();
}

// The chat and the Routine view follow the connected account; the Routine list is read once so an
// idle panel knows whether to look for scheduled runs.
function setAccount(): void {
  const account = accountOf(ready());
  chat.setAccount(account);
  routinesView.setAccount(account);
  routinesScheduled = false;
  const current = ready();
  if (current) void listRoutines(current).then(list => { routinesScheduled = list.items.some(item => item.thread.schedule?.enabled); }, () => {});
}

// The chat and the Routine view need a connected Worker: until then Settings stays shown.
function show(next: PanelView): void {
  view = next !== "settings" && !ready() ? "settings" : next;
  shell.show(view);
  renderSettings();
  if (view === "routines") routinesView.show();
  else routinesView.hide();
  if (view === "chat") chat.focus();
}

function renderSettings(): void {
  settingsRoot.render(<SettingsView settings={settings} open={view === "settings"} onConnected={connected} onDisconnect={disconnect} />);
}

function renderStatus(): void {
  shell.status.textContent = !ready() ? "Not connected" : browserStatus || (turnsActive ? "Working" : "Ready");
}

// The work loop: one browser call at a time, only while a turn is not terminal. The claim then
// waits on the Worker for the next call, so a call starts as soon as the model makes it. Idle, it
// sends nothing and sleeps until a response shows an active turn.
async function workLoop(): Promise<void> {
  for (;;) {
    const current = ready();
    if (!current || !turnsActive) {
      // Idle, it waits for a response that shows an active turn; with a Routine on a schedule it
      // also looks once a minute (while the panel is visible) for a run that needs the browser.
      const looked = await new Promise<boolean>(resolve => {
        const timer = current && routinesScheduled ? setTimeout(() => { wakeWork = null; resolve(true); }, IDLE_POLL_MS) : undefined;
        wakeWork = () => { clearTimeout(timer); wakeWork = null; resolve(false); };
      });
      if (looked && document.visibilityState === "visible") turnsActive = true;
      continue;
    }
    try {
      const work = await runOneBrowserCall(current, deps, codeSandbox, action => { browserStatus = `Browser: ${action}`; renderStatus(); }, CLAIM_WAIT_MS);
      turnsActive = work.ran || work.activeTurns > 0;
    } catch {
      // The chat reports an unreachable Worker; claims resume when a response shows an active turn.
      turnsActive = false;
      await new Promise(resolve => setTimeout(resolve, ACTIVE_POLL_MS));
    } finally {
      browserStatus = "";
      renderStatus();
    }
  }
}

// The confirmation seam: an action that commits something outside the page waits for the user's
// "Allow once" here, or is declined (by the user, or when nobody answers in four minutes).
function askUser(request: ConfirmRequest): Promise<boolean> {
  return new Promise(resolve => {
    const answer = (allowed: boolean) => { clearTimeout(expiry); confirmation = null; chat.render(); resolve(allowed); };
    const expiry = setTimeout(() => answer(false), CONFIRM_TIMEOUT_MS);
    confirmation = { request, answer };
    // The card is in the chat: a Routine run may ask while another view is shown.
    if (view !== "chat") show("chat");
    chat.render();
  });
}

function ConfirmCard({ request, onAnswer }: { request: ConfirmRequest; onAnswer(allowed: boolean): void }) {
  return <section id="confirm" className="confirm" role="alertdialog" aria-label="Allow this action?">
    <p><strong>Allow this action?</strong></p>
    <p id="confirm-reason">{request.reason}</p>
    <p className="hint">{request.title} - {request.url}</p>
    <div className="row">
      <button id="confirm-allow" className="button primary" type="button" onClick={() => onAnswer(true)}>Allow once</button>
      <button id="confirm-deny" className="button" type="button" onClick={() => onAnswer(false)}>Decline</button>
    </div>
  </section>;
}

void init();
