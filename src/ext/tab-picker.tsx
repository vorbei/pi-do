// The tab a message is about: the user's choice (the current tab by default, one of the window's
// web tabs, or no tab), the context it resolves to when a message is sent, and the picker above
// the composer that shows and changes it.
import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { httpUrl, type TabContext } from "../shared/protocol.ts";

/** "current": the tab the user is looking at when the message is sent; a number: that tab. */
export type TabChoice = "current" | "none" | number;

type Tab = chrome.tabs.Tab;
type TabEvent = { addListener(listener: () => void): void; removeListener(listener: () => void): void };
/** The part of chrome.tabs the choice reads. */
export interface TabsApi {
  query(query: chrome.tabs.QueryInfo): Promise<Tab[]>;
  get(tabId: number): Promise<Tab>;
  onActivated: TabEvent;
  onUpdated: TabEvent;
  onRemoved: { addListener(listener: (tabId: number) => void): void; removeListener(listener: (tabId: number) => void): void };
}

export interface TabChoiceStore {
  get(): TabChoice;
  set(choice: TabChoice): void;
  subscribe(listener: () => void): () => void;
  /** What a message sent now is about: null for no tab, or when no web tab is open. */
  context(): Promise<TabContext | null>;
  /** The tab "current" means now. */
  current(): Promise<TabContext | null>;
  /** The web tabs the user can choose: the current window's, or every window's when it has none (the panel opened as a tab). */
  tabs(): Promise<TabContext[]>;
}

const usable = (tab: Tab | null | undefined): tab is Tab & { id: number } => tab?.id !== undefined && httpUrl(tab.url ?? "") !== null && !tab.incognito;
const contextOf = (tab: Tab & { id: number }): TabContext => ({ tabId: tab.id, url: tab.url ?? "", title: tab.title ?? "" });

export function tabChoiceStore(api: TabsApi): TabChoiceStore {
  let choice: TabChoice = "current";
  const listeners = new Set<() => void>();
  const set = (next: TabChoice) => { if (next === choice) return; choice = next; for (const listener of listeners) listener(); };
  // A chosen tab that closes gives way to the current tab.
  api.onRemoved.addListener(tabId => { if (choice === tabId) set("current"); });
  // The tab the user is looking at; an extension page (the panel opened as a tab) falls back to the last web tab.
  const current = async () => {
    const [active] = await api.query({ active: true, currentWindow: true });
    const candidates = usable(active) ? [active] : (await api.query({})).filter(usable).sort((a, b) => (b.lastAccessed ?? 0) - (a.lastAccessed ?? 0));
    return usable(candidates[0]) ? contextOf(candidates[0]) : null;
  };
  return {
    get: () => choice,
    set,
    subscribe(listener) { listeners.add(listener); return () => { listeners.delete(listener); }; },
    current,
    async context() {
      if (choice === "none") return null;
      if (choice !== "current") {
        const tab = await api.get(choice).catch(() => null);
        if (usable(tab)) return contextOf(tab);
      }
      return current();
    },
    async tabs() {
      const own = (await api.query({ currentWindow: true })).filter(usable);
      return (own.length ? own : (await api.query({})).filter(usable)).map(contextOf);
    },
  };
}

const hostOf = (url: string) => { try { return new URL(url).host; } catch { return url; } };
const titleOf = (tab: TabContext) => tab.title || tab.url;

/** The picker: its trigger names what the next message is about; its menu offers the current tab, the window's tabs and no tab. */
export function TabPicker({ store, api }: { store: TabChoiceStore; api: TabsApi }) {
  const choice = useSyncExternalStore(store.subscribe, store.get);
  const [open, setOpen] = useState(false);
  const [current, setCurrent] = useState<TabContext | null>(null);
  const [tabs, setTabs] = useState<TabContext[]>([]);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    let live = true;
    const read = () => void Promise.all([store.current(), store.tabs()]).then(([now, list]) => { if (live) { setCurrent(now); setTabs(list); } }, () => {});
    read();
    api.onActivated.addListener(read);
    api.onUpdated.addListener(read);
    api.onRemoved.addListener(read);
    return () => { live = false; api.onActivated.removeListener(read); api.onUpdated.removeListener(read); api.onRemoved.removeListener(read); };
  }, [store, api]);
  useEffect(() => {
    if (!open) return undefined;
    const outside = (event: Event) => { if (!ref.current?.contains(event.target as Node)) setOpen(false); };
    const escape = (event: KeyboardEvent) => { if (event.key === "Escape") setOpen(false); };
    document.addEventListener("pointerdown", outside);
    document.addEventListener("keydown", escape);
    return () => { document.removeEventListener("pointerdown", outside); document.removeEventListener("keydown", escape); };
  }, [open]);
  const chosen = typeof choice === "number" ? tabs.find(tab => tab.tabId === choice) ?? null : null;
  const shown = choice === "none" ? null : chosen ?? current;
  const label = choice === "none" ? "No tab" : shown ? `Tab: ${titleOf(shown)}` : "No web tab open";
  const choose = (next: TabChoice) => { store.set(next); setOpen(false); };
  const item = (value: TabChoice, title: string, detail: string, key: string, tabId?: number) =>
    <button key={key} type="button" role="menuitemradio" aria-checked={choice === value} data-tab-id={tabId} onClick={() => choose(value)}>
      <span className="chat-panel-menu-icon" aria-hidden="true">{choice === value && <CheckIcon />}</span>
      <span><strong>{title}</strong><small>{detail}</small></span>
    </button>;
  return <div ref={ref} className="tab-picker">
    <button type="button" className="tab-picker-trigger" aria-haspopup="menu" aria-expanded={open} title={shown?.url ?? label}
      aria-label={`The tab this message is about: ${label.replace(/^Tab: /, "")}`} onClick={() => setOpen(value => !value)}>
      <TabIcon /><span>{label}</span><ChevronIcon />
    </button>
    {open && <div className="chat-panel-popover tab-picker-menu" role="menu" aria-label="The tab this message is about">
      {item("current", "Current tab", current ? titleOf(current) : "No web tab open", "current")}
      {tabs.map(tab => item(tab.tabId, titleOf(tab), hostOf(tab.url), String(tab.tabId), tab.tabId))}
      {item("none", "No tab", "Send without a page", "none")}
    </div>}
  </div>;
}

function TabIcon() {
  return <svg viewBox="0 0 24 24" aria-hidden="true"><rect x="3" y="5" width="18" height="14" rx="2" /><path d="M3 9h18" /></svg>;
}
function ChevronIcon() {
  return <svg viewBox="0 0 24 24" aria-hidden="true"><path d="m7 10 5 5 5-5" /></svg>;
}
function CheckIcon() {
  return <svg viewBox="0 0 24 24"><path d="M20 6 9 17l-5-5" /></svg>;
}
