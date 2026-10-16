import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Settings } from "../src/ext/api.ts";
import { SettingsView, WorkWindowChoice } from "../src/ext/settings.tsx";
import { browserGlobals } from "./helpers/dom.ts";

describe("Where Pi works, in Settings", () => {
  let env: ReturnType<typeof browserGlobals>;
  afterEach(() => { env.restore(); vi.unstubAllGlobals(); });

  async function render(settings: Partial<Settings>) {
    env = browserGlobals("<html><body><main></main></body></html>");
    const stored: Record<string, unknown>[] = [];
    vi.stubGlobal("chrome", { storage: { local: { set: async (values: Record<string, unknown>) => { stored.push(values); } } } });
    const root = createRoot(env.document.querySelector("main")!);
    await act(async () => { root.render(createElement(WorkWindowChoice, { settings })); });
    const select = env.document.querySelector("select[name=work-window]") as HTMLSelectElement;
    return { stored, select };
  }

  it("defaults to the agent's own window, and stores This window for the next tab the agent opens", async () => {
    const settings: Partial<Settings> = {};
    const { stored, select } = await render(settings);
    expect(select.closest("label")?.textContent).toContain("Where Pi works");
    expect(select.value).toBe("own");
    // linkedom's select has no value setter: choose the option the way a user's pick leaves it.
    await act(async () => { for (const option of select.options) option.toggleAttribute("selected", option.value === "this"); env.fire(select, "change"); });
    expect(stored).toEqual([{ workWindow: "this" }]);
    // The panel's executor reads the same settings object at each `open`.
    expect(settings.workWindow).toBe("this");
  });

  it("shows a stored choice", async () => {
    const { select } = await render({ workWindow: "this" });
    expect(select.value).toBe("this");
  });
});

describe("Settings: the connection and the saved memories", () => {
  let env: ReturnType<typeof browserGlobals>;
  afterEach(() => { env.restore(); vi.unstubAllGlobals(); });

  const WORKER = "https://pi-do.example.workers.dev";
  const memory = { instructions: [{ memoryId: "m1", content: "End with a summary.", confirmed: false, expiresAt: null }],
    memories: [{ memoryId: "m2", kind: "fact", content: "Uses the web app.", expiresAt: null }] };

  async function render(settings: Partial<Settings>) {
    env = browserGlobals("<html><body><main></main></body></html>");
    const requests: string[] = [];
    vi.stubGlobal("chrome", { storage: { local: { set: async () => {} } } });
    vi.stubGlobal("fetch", async (url: string, init: RequestInit) => {
      requests.push(`${init.method} ${url.slice(WORKER.length)}`);
      return new Response(JSON.stringify(url.endsWith("/api/memory") ? memory : {}), { status: 200 });
    });
    const onDisconnect = vi.fn(async () => {});
    const root = createRoot(env.document.querySelector("main")!);
    await act(async () => { root.render(createElement(SettingsView, { settings, open: true, onConnected: async () => {}, onDisconnect })); });
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 0)); });
    return { requests, onDisconnect, buttons: () => [...env.document.querySelectorAll("button")] as HTMLButtonElement[] };
  }

  it("shows a connected Worker as one row with Disconnect, and no connect form", async () => {
    const { onDisconnect, buttons } = await render({ workerUrl: WORKER, token: "acct_0123456789abcdef.secret" });
    expect(env.document.getElementById("connect-form")).toBeNull();
    const account = env.document.getElementById("account")!;
    expect(account.textContent).toContain("pi-do.example.workers.dev");
    expect(account.getAttribute("title")).toContain("acct_0123456789abcdef");
    await act(async () => { env.fire(buttons().find(button => button.textContent === "Disconnect")!, "click"); });
    expect(onDisconnect).toHaveBeenCalledOnce();
  });

  it("lists saved memories: a waiting instruction can be confirmed, and every memory removed", async () => {
    const { requests, buttons } = await render({ workerUrl: WORKER, token: "acct_1.secret" });
    const items = [...env.document.querySelectorAll("#memory-list li")];
    expect(items.map(item => item.className)).toEqual(["pending", "saved"]);
    expect(buttons().filter(button => button.getAttribute("aria-label") === "Remove")).toHaveLength(2);
    await act(async () => { env.fire(items[0]!.querySelector("button")!, "click"); });
    await act(async () => { env.fire(items[1]!.querySelector("button[aria-label=Remove]")!, "click"); });
    expect(requests.filter(request => request.startsWith("POST"))).toEqual(["POST /api/memory/m1/confirm", "POST /api/memory/m2/forget"]);
  });

  it("asks for the Worker URL and the bootstrap secret when not connected", async () => {
    await render({ workerUrl: WORKER });
    expect(env.document.getElementById("connect-form")).not.toBeNull();
    expect(env.document.getElementById("account")).toBeNull();
    expect((env.document.getElementById("worker-url") as HTMLInputElement).value).toBe(WORKER);
  });
});
