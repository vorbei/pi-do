// The Settings view (the "…" menu's Settings): connect to a Worker with the bootstrap secret (once;
// the secret is not stored), disconnect, where the agent opens tabs, the Memory updates switch, and
// the Memory view (standing instructions to confirm, saved facts and events, each removable).
import { useEffect, useState, type FormEvent } from "react";
import type { MemoryView } from "../shared/protocol.ts";
import { ApiError, bootstrap, changeMemory, listMemory, normalizeWorkerUrl, saveSettings, type Settings, type WorkWindow } from "./api.ts";

/** The Worker URL the build was pointed at (`build-extension.ts --worker-url`), or "". */
declare const PI_DO_DEFAULT_WORKER_URL: string;

const codeOf = (error: unknown) => error instanceof ApiError ? error.code : String(error);
const hostOf = (url: string) => { try { return new URL(url).host; } catch { return url; } };
const shortId = (id: string) => id.length > 14 ? `${id.slice(0, 9)}\u2026${id.slice(-4)}` : id;

export function SettingsView({ settings, open, onConnected, onDisconnect }: {
  settings: Partial<Settings>;
  open: boolean;
  onConnected(workerUrl: string, token: string): Promise<void>;
  onDisconnect(): Promise<void>;
}) {
  return <>
    <header className="settings-head"><h2>Settings</h2></header>
    <section className="settings-section">
      <h3 className="settings-label">Worker</h3>
      {settings.token && settings.workerUrl
        ? <Connection workerUrl={settings.workerUrl} accountId={settings.token.split(".")[0]} onDisconnect={onDisconnect} />
        : <ConnectForm initialUrl={settings.workerUrl ?? PI_DO_DEFAULT_WORKER_URL} onConnected={onConnected} />}
    </section>
    <section className="settings-section">
      <h3 className="settings-label">Browser</h3>
      <WorkWindowChoice settings={settings} />
    </section>
    <section className="settings-section">
      <h3 className="settings-label">Memory</h3>
      <MemorySwitch settings={settings} />
      {open && settings.token && settings.workerUrl && <MemoryList settings={settings as Settings} />}
    </section>
  </>;
}

// The connected Worker as one row: its host and the shortened account id, the full ones on hover.
function Connection({ workerUrl, accountId, onDisconnect }: { workerUrl: string; accountId: string; onDisconnect(): Promise<void> }) {
  return <div id="account" className="settings-row" title={`${workerUrl}\n${accountId}`}>
    <span className="settings-row-text">
      <span className="settings-row-label">{`Connected \u00b7 ${hostOf(workerUrl)}`}</span>
      <small>{shortId(accountId)}</small>
    </span>
    <button className="button" type="button" onClick={() => void onDisconnect()}>Disconnect</button>
  </div>;
}

// Connect with the bootstrap secret, once; the secret is not stored.
function ConnectForm({ initialUrl, onConnected }: { initialUrl: string; onConnected(workerUrl: string, token: string): Promise<void> }) {
  const [workerUrl, setWorkerUrl] = useState(initialUrl);
  const [secret, setSecret] = useState("");
  const [error, setError] = useState("");
  async function connect(event: FormEvent) {
    event.preventDefault();
    try {
      const url = normalizeWorkerUrl(workerUrl);
      const { token } = await bootstrap(url, secret);
      setSecret("");
      setError("");
      await onConnected(url, token);
    } catch (cause) { setError(`Connect failed: ${codeOf(cause)}`); }
  }
  return <form id="connect-form" className="settings-form" onSubmit={connect}>
    <label className="settings-field">Worker URL <input id="worker-url" type="url" placeholder="https://pi-do-browser-ext.example.workers.dev" required
      value={workerUrl} onChange={event => setWorkerUrl(event.target.value)} /></label>
    <label className="settings-field">Bootstrap secret <input id="bootstrap-secret" type="password" autoComplete="off" required aria-describedby="bootstrap-secret-hint"
      value={secret} onChange={event => setSecret(event.target.value)} /></label>
    <p id="bootstrap-secret-hint" className="settings-hint">From whoever deployed the Worker; not stored.</p>
    {error && <p className="settings-hint is-error" role="alert">{error}</p>}
    <button className="button primary" type="submit">Connect</button>
  </form>;
}

// Whether the agent may save, replace or forget memories while answering; unset means on, and
// every message states it.
function MemorySwitch({ settings }: { settings: Partial<Settings> }) {
  const [enabled, setEnabled] = useState(settings.memoryUpdate !== false);
  const label = "Memory updates";
  return <label className="setting-row">
    <span className="settings-row-text">
      <span className="settings-row-label">{label}</span>
      <small>Pi saves and forgets memories as it answers.</small>
    </span>
    <input id="memory-update" type="checkbox" aria-label={label} checked={enabled} onChange={event => {
      const value = event.target.checked;
      setEnabled(value);
      settings.memoryUpdate = value;
      void saveSettings({ memoryUpdate: value });
    }} /><i></i>
  </label>;
}

// Where the agent opens tabs; unset means its own window. Read at each `open`, so a change applies
// to the next tab it opens.
export function WorkWindowChoice({ settings }: { settings: Partial<Settings> }) {
  const [choice, setChoice] = useState<WorkWindow>(settings.workWindow ?? "own");
  const hints: Record<WorkWindow, string> = { own: "Your tabs stay as they are.", this: "Pi's tabs open next to yours and come forward when it acts." };
  return <label className="settings-row">
    <span className="settings-row-text">
      <span className="settings-row-label">Where Pi works</span>
      <small id="work-window-hint">{hints[choice]}</small>
    </span>
    <select id="work-window" name="work-window" value={choice} aria-describedby="work-window-hint" onChange={event => {
      const value = event.target.value as WorkWindow;
      setChoice(value);
      settings.workWindow = value;
      void saveSettings({ workWindow: value });
    }}>
      <option value="own">Its own window</option>
      <option value="this">This window</option>
    </select>
  </label>;
}

// Lucide trash-2, the outline style of the panel's icons.
const REMOVE_ICON = <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M10 11v6m4-6v6m5-11v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6M3 6h18M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" /></svg>;

function MemoryList({ settings }: { settings: Settings }) {
  const [view, setView] = useState<MemoryView | null>(null);
  const [error, setError] = useState("");
  const load = () => listMemory(settings).then(next => { setView(next); setError(""); }, cause => setError(`Memory unavailable: ${codeOf(cause)}`));
  useEffect(() => { void load(); }, [settings.token]);
  const change = async (memoryId: string, kind: "confirm" | "forget") => { await changeMemory(settings, memoryId, kind).catch(() => {}); await load(); };
  const until = (expiresAt: string | null) => expiresAt ? `Until ${new Date(expiresAt).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" })}` : "";
  const remove = (memoryId: string) => <button className="icon-button" type="button" aria-label="Remove" title="Remove" onClick={() => void change(memoryId, "forget")}>{REMOVE_ICON}</button>;
  if (error) return <p className="settings-hint">{error}</p>;
  if (!view) return null;
  if (!view.instructions.length && !view.memories.length) return <p className="settings-hint">Nothing saved yet.</p>;
  return <ul id="memory-list" className="memory-list">
    {view.instructions.map(item => <li key={item.memoryId} className={item.confirmed ? "confirmed" : "pending"}>
      <div className="memory-text">
        <p>{item.content}</p>
        <small><span className="memory-tag">Instruction</span>{item.confirmed ? until(item.expiresAt) : "Applies after you confirm"}</small>
      </div>
      <div className="memory-actions">
        {!item.confirmed && <button className="button primary" type="button" onClick={() => void change(item.memoryId, "confirm")}>Confirm</button>}
        {remove(item.memoryId)}
      </div>
    </li>)}
    {view.memories.map(item => <li key={item.memoryId} className="saved">
      <div className="memory-text">
        <p>{item.content}</p>
        <small><span className="memory-tag">{item.kind === "fact" ? "Fact" : "Event"}</span>{until(item.expiresAt)}</small>
      </div>
      <div className="memory-actions">{remove(item.memoryId)}</div>
    </li>)}
  </ul>;
}
