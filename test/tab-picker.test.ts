import { createElement } from "react";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { piDoChatClient } from "../src/ext/chat-client.ts";
import { TabPicker, tabChoiceStore, type TabsApi } from "../src/ext/tab-picker.tsx";
import { browserGlobals } from "./helpers/dom.ts";

type Tab = chrome.tabs.Tab;
const tab = (id: number, windowId: number, title: string, url: string, active = false) => ({ id, windowId, title, url, active, incognito: false, lastAccessed: id }) as unknown as Tab;

/** chrome.tabs over a fixed set of tabs; window 1 is the current one. */
function fakeTabs(tabs: Tab[]) {
  const removed = new Set<(tabId: number) => void>();
  const event = () => ({ addListener() {}, removeListener() {} });
  const api: TabsApi = {
    query: async query => tabs.filter(item => (!query.currentWindow || item.windowId === 1) && (!query.active || item.active)),
    get: async tabId => { const found = tabs.find(item => item.id === tabId); if (!found) throw new Error("No tab"); return found; },
    onActivated: event(), onUpdated: event(),
    onRemoved: { addListener: listener => { removed.add(listener); }, removeListener: listener => { removed.delete(listener); } },
  };
  return { api, close(tabId: number) { tabs.splice(tabs.findIndex(item => item.id === tabId), 1); for (const listener of removed) listener(tabId); } };
}

const SETTINGS = { workerUrl: "https://worker.example", token: "acct_1.secret", memoryUpdate: true };

describe("the tab a message is about", () => {
  let env: ReturnType<typeof browserGlobals>;
  afterEach(() => { env.restore(); vi.unstubAllGlobals(); });

  async function render(tabs: Tab[]) {
    env = browserGlobals("<html><body><main></main></body></html>");
    const fake = fakeTabs(tabs);
    const store = tabChoiceStore(fake.api);
    const root = createRoot(env.document.querySelector("main")!);
    await act(async () => { root.render(createElement(TabPicker, { store, api: fake.api })); });
    const sent: unknown[] = [];
    vi.stubGlobal("fetch", async (_url: string, init: RequestInit) => {
      sent.push(JSON.parse(String(init.body)).context);
      return new Response(JSON.stringify({ turn: { turnId: "turn_1", status: "completed" } }));
    });
    const client = piDoChatClient({ settings: () => SETTINGS, tabContext: () => store.context(), onActivity() {}, onUnauthorized() {} });
    const send = () => client.submitTurn({ threadId: "t_1", text: "About this", whileRunning: "steer", idempotencyKey: "chat:t_1:1" });
    const trigger = () => env.document.querySelector(".tab-picker-trigger")!;
    const options = () => [...env.document.querySelectorAll("[role=menuitemradio]")];
    const click = (element: Element) => act(async () => { env.fire(element, "click"); });
    const choose = async (title: string) => {
      await click(trigger());
      await click(options().find(option => option.querySelector("strong")!.textContent === title)!);
    };
    return { store, fake, sent, send, trigger, options, click, choose, unmount: () => act(async () => root.unmount()) };
  }

  const window1 = () => [tab(11, 1, "Release notes", "https://example.com/notes", true), tab(12, 1, "Pricing", "https://example.com/pricing"),
    tab(13, 2, "Other window", "https://other.example/")];

  it("is the current tab by default, and the menu lists it, the window's web tabs and no tab", async () => {
    const picker = await render(window1());
    expect(picker.trigger().textContent).toBe("Tab: Release notes");
    await picker.send();
    expect(picker.sent).toEqual([{ tabId: 11, url: "https://example.com/notes", title: "Release notes" }]);
    await picker.click(picker.trigger());
    expect(picker.options().map(option => [option.querySelector("strong")!.textContent, option.getAttribute("aria-checked")])).toEqual([
      ["Current tab", "true"], ["Release notes", "false"], ["Pricing", "false"], ["No tab", "false"]]);
    await picker.unmount();
  });

  it("switches to another tab and clears to no tab; each message carries the choice", async () => {
    const picker = await render(window1());
    await picker.choose("Pricing");
    expect(picker.options()).toEqual([]);
    expect(picker.trigger().textContent).toBe("Tab: Pricing");
    await picker.send();
    await picker.choose("No tab");
    expect(picker.trigger().textContent).toBe("No tab");
    await picker.send();
    await picker.choose("Current tab");
    await picker.send();
    expect(picker.sent).toEqual([
      { tabId: 12, url: "https://example.com/pricing", title: "Pricing" }, null,
      { tabId: 11, url: "https://example.com/notes", title: "Release notes" }]);
    await picker.unmount();
  });

  it("falls back to the current tab when the chosen tab closes", async () => {
    const picker = await render(window1());
    await picker.choose("Pricing");
    await act(async () => { picker.fake.close(12); });
    expect(picker.store.get()).toBe("current");
    expect(picker.trigger().textContent).toBe("Tab: Release notes");
    await picker.unmount();
  });

  it("offers every window's web tabs when the panel's own window has none (the panel opened as a tab)", async () => {
    const picker = await render([tab(21, 1, "Panel", "chrome-extension://abc/panel.html", true), tab(22, 2, "Fixture", "http://127.0.0.1:8080/")]);
    expect(picker.trigger().textContent).toBe("Tab: Fixture");
    await picker.click(picker.trigger());
    expect(picker.options().map(option => option.querySelector("strong")!.textContent)).toEqual(["Current tab", "Fixture", "No tab"]);
    await picker.unmount();
  });
});
