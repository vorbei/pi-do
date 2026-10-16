import { describe, expect, it } from "vitest";
import { onTab as withTab, type ChromeApi } from "../src/browser/cdp.ts";
import { executeBrowserCall, type ExecutorDeps } from "../src/browser/executor.ts";
import type { BrowserCall, PdfTextRequest, PdfTextResponse, TargetSummary } from "../src/shared/protocol.ts";
import type { AXNode } from "../src/browser/snapshot.ts";
import { PAGE } from "./fixtures/ax-page.ts";

interface FakeOptions {
  frames?: string[];
  tabUrl?: string;
  /** The main frame shows Chrome's PDF viewer. */
  pdf?: boolean;
  /** Page.navigate commits this URL and then Chrome detaches the debugger, as its PDF viewer does. */
  detachOnNavigate?: string;
  /** The page embeds a cross-process iframe (session "s1") with one button. */
  oopif?: boolean;
  /** What the main document and the cross-process iframe report as focused. */
  mainFocus?: TargetSummary | null;
  childFocus?: TargetSummary | null;
  /** A click (mouse release) opens this URL in a new tab whose opener is tab 1. */
  clickOpens?: string;
  /** What covers every click point in the main frame (a cookie banner). */
  covering?: { tag: string; role: string | null; name: string };
  /** The main frame's discovery of controls without an ARIA role throws in the page. */
  discoveryFails?: boolean;
  /** What the loaded page reports: its HTTP status, Chrome's error page, its text and element counts (a page that loaded by default). */
  load?: { status?: number; errorPage?: boolean; type?: string; text?: number; elements?: number };
}

// A Chrome API fake: tabs plus a debugger that answers the CDP methods the executor uses
// from a fixed accessibility tree, and records every command it receives.
function fakeChrome(options: FakeOptions = {}) {
  const sent: { method: string; params?: Record<string, unknown>; sessionId?: string }[] = [];
  let loaderId = "doc1";
  let detached = false;
  const eventListeners: ((source: { tabId?: number; sessionId?: string }, method: string, params?: unknown) => void)[] = [];
  // The cross-process iframe: its own session, frame tree and accessibility tree.
  const oopif = options.oopif ? {
    tree: { frame: { id: "widget", url: "https://widget.example/w", loaderId: "wdoc" } },
    nodes: [
      { nodeId: "w", role: { value: "RootWebArea" }, childIds: ["b"] },
      { nodeId: "b", parentId: "w", role: { value: "button" }, name: { value: "Shadow click" }, backendDOMNodeId: 60 },
    ] as AXNode[],
  } : null;
  const mainNodes: AXNode[] = oopif ? [{ ...PAGE[0], childIds: [...PAGE[0].childIds!, "if"] }, ...PAGE.slice(1),
    { nodeId: "if", parentId: "1", role: { value: "Iframe" }, name: { value: "Widget" }, backendDOMNodeId: 90 }] : PAGE;
  const childHandlers: Record<string, (params?: Record<string, unknown>) => unknown> = {
    "Page.getFrameTree": () => ({ frameTree: oopif!.tree }),
    "Accessibility.getFullAXTree": () => ({ nodes: oopif!.nodes }),
    "DOM.describeNode": () => ({ node: { nodeName: "BUTTON", attributes: [] } }),
    "DOM.resolveNode": () => ({ object: { objectId: "child-obj" } }),
    // The pre-click hit test finds the button at its point; other node checks answer false.
    "Runtime.callFunctionOn": params => ({ result: { value: /elementFromPoint/.test(String(params?.functionDeclaration)) } }),
    "DOM.getBoxModel": () => ({ model: { content: [100, 100, 120, 100, 120, 120, 100, 120] } }),
    "Page.createIsolatedWorld": () => ({ executionContextId: 7 }),
    "Runtime.evaluate": params => ({ result: { value: /activeElement/.test(String(params?.expression)) ? options.childFocus ?? null
      : params?.contextId === 7 ? "Widget text" : "?" } }),
  };
  const tabs: chrome.tabs.Tab[] = [
    { id: 1, url: options.tabUrl ?? "https://shop.example/checkout", title: "Shop", active: true, incognito: false, status: "complete" } as chrome.tabs.Tab,
    { id: 2, url: "chrome://settings", title: "Settings", incognito: false } as chrome.tabs.Tab,
    { id: 3, url: "https://private.example/", title: "Private", incognito: true } as chrome.tabs.Tab,
  ];
  const listener = { addListener() {}, removeListener() {} };
  const createdListeners = new Set<(tab: chrome.tabs.Tab) => void>();
  const handlers: Record<string, (params?: Record<string, unknown>) => unknown> = {
    "Page.getFrameTree": () => ({ frameTree: { frame: { id: "main", url: tabs[0].url, loaderId, mimeType: options.pdf ? "application/pdf" : "text/html" },
      childFrames: (options.frames ?? []).map((url, index) => ({ frame: { id: `child${index}`, url, loaderId: "child" } })) } }),
    "Accessibility.getFullAXTree": params => ({ nodes: params?.frameId === "main" ? mainNodes : [] }),
    "DOM.describeNode": params => ({ node: params?.backendNodeId === 90 ? { nodeName: "IFRAME", frameId: "widget" }
      : params?.backendNodeId === 50 ? { nodeName: "INPUT", attributes: ["type", "password"] } : { nodeName: "INPUT", attributes: ["type", "email"] } }),
    "Target.setAutoAttach": () => {
      if (oopif) for (const listener of eventListeners) listener({ tabId: 1 }, "Target.attachedToTarget", { sessionId: "s1", targetInfo: { type: "iframe" } });
      return {};
    },
    "DOM.resolveNode": () => ({ object: { objectId: "obj" } }),
    "Runtime.callFunctionOn": params => /querySelectorAll\('\*'\)/.test(String(params?.functionDeclaration))
      ? options.discoveryFails ? { exceptionDetails: { text: "TypeError" } } : { result: { objectId: "clickables" } }
      : params?.objectId === "clickables" ? { result: { value: [] } }
      : { result: { value: options.covering && /elementFromPoint/.test(String(params?.functionDeclaration))
        ? { covering: options.covering } : true } },
    "Runtime.getProperties": () => ({ result: [] }),
    "DOM.getBoxModel": () => ({ model: { content: [0, 0, 10, 0, 10, 10, 0, 10] } }),
    "Page.getLayoutMetrics": () => ({ cssVisualViewport: { clientWidth: 800, clientHeight: 600 } }),
    "Runtime.evaluate": params => params?.expression === "document" ? { result: { objectId: "doc" } }
      : /responseStatus/.test(String(params?.expression)) ? { result: { value: { status: 200, errorPage: false, text: 120, elements: 4, ...options.load } } }
      : /activeElement/.test(String(params?.expression)) ? { result: { value: options.mainFocus ?? null } }
      : params?.awaitPromise && /scrollBy/.test(String(params?.expression))
        ? { result: { value: { deltaX: 0, deltaY: 480, scrollX: 0, scrollY: 480, scrollHeight: 2000, viewportHeight: 600 } } }
      : /scrollY/.test(String(params?.expression)) ? { result: { value: [480, 2000, 600] } }
      : { result: { value: "page text" } },
    "Page.navigate": params => {
      if (options.detachOnNavigate) { tabs[0].url = options.detachOnNavigate; detached = true; }
      return { frameId: "main", loaderId: "doc2", url: params?.url };
    },
  };
  const api = {
    tabs: {
      get: async (id: number) => { const tab = tabs.find(item => item.id === id); if (!tab) throw new Error("no tab"); return tab; },
      query: async (filter: { active?: boolean } = {}) => tabs.filter(tab => !filter.active || tab.active),
      create: async (params: { url: string; windowId?: number }) => {
        sent.push({ method: "tabs.create", params });
        const tab = { id: 9, url: params.url, title: "New", status: "complete", windowId: params.windowId ?? 1 } as chrome.tabs.Tab;
        tabs.push(tab);
        return tab;
      },
      remove: async (id: number) => { sent.push({ method: "tabs.remove", params: { id } }); tabs.splice(tabs.findIndex(tab => tab.id === id), 1); },
      update: async (id: number, change: { active?: boolean }) => {
        sent.push({ method: "tabs.update", params: { id, ...change } });
        const tab = tabs.find(item => item.id === id);
        if (tab && change.active) tab.active = true;
        return tab;
      },
      onRemoved: listener,
      onCreated: { addListener: (fn: (tab: chrome.tabs.Tab) => void) => createdListeners.add(fn), removeListener: (fn: (tab: chrome.tabs.Tab) => void) => createdListeners.delete(fn) },
    },
    debugger: {
      attach: async () => {},
      detach: async () => {},
      sendCommand: async (target: { sessionId?: string }, method: string, params?: Record<string, unknown>) => {
        if (detached) throw new Error("Debugger is not attached to the tab with id: 1.");
        sent.push({ method, params, ...(target.sessionId ? { sessionId: target.sessionId } : {}) });
        if (target.sessionId) return childHandlers[method]?.(params) ?? {};
        if (method === "Input.dispatchMouseEvent" && params?.type === "mouseReleased" && options.clickOpens) {
          const child = { id: 10, openerTabId: 1, url: options.clickOpens, title: "Details", status: "complete", incognito: false } as chrome.tabs.Tab;
          tabs.push(child);
          for (const created of createdListeners) created(child);
        }
        return handlers[method]?.(params) ?? {};
      },
      onDetach: listener,
      onEvent: { addListener: (fn: (typeof eventListeners)[number]) => eventListeners.push(fn), removeListener() {} },
    },
  } as unknown as ChromeApi;
  return { api, sent, tabs, navigate: () => { loaderId = "doc2"; } };
}

/** `pdf` answers the Worker's PDF read; every request the extension sends it is recorded. */
function deps(api: ChromeApi, answer: boolean | null, pdf: (request: PdfTextRequest) => PdfTextResponse = () => { throw new Error("no PDF read expected"); }) {
  const asked: string[] = [];
  const pdfRequests: PdfTextRequest[] = [];
  const value: ExecutorDeps = { api, sleep: async () => {}, confirm: async request => {
    asked.push(request.reason);
    if (answer === null) throw new Error("confirmation was not expected");
    return answer;
  }, pdfText: async request => { pdfRequests.push(request); return pdf(request); } };
  return { value, asked, pdfRequests };
}

const run = (d: ExecutorDeps, call: BrowserCall) => executeBrowserCall(d, call);
const mouseDown = (sent: { method: string; params?: Record<string, unknown> }[]) =>
  sent.filter(item => item.method === "Input.dispatchMouseEvent" && item.params?.type === "mousePressed");

describe("browser executor", () => {
  it("asks before clicking a commit button and dispatches nothing when declined", async () => {
    const chrome = fakeChrome();
    const declined = deps(chrome.api, false);
    await run(declined.value, { action: "snapshot", tabId: 1 });
    await expect(run(declined.value, { action: "click", tabId: 1, ref: "e3" })).rejects.toMatchObject({ code: "USER_DECLINED" });
    expect(declined.asked).toEqual(['click button "Send order"']);
    expect(mouseDown(chrome.sent)).toHaveLength(0);

    const approved = deps(chrome.api, true);
    const result = await run(approved.value, { action: "click", tabId: 1, ref: "e3" });
    expect(result.text).toMatch(/^Clicked button "Send order"/);
    expect(mouseDown(chrome.sent)).toHaveLength(1);
  });

  it("snapshots a cross-process iframe through its session and sends a click on its ref there", async () => {
    const chrome = fakeChrome({ oopif: true });
    const d = deps(chrome.api, null);
    const snapshot = await run(d.value, { action: "snapshot", tabId: 1 });
    expect(snapshot.text).toContain('- iframe "Widget" [url=https://widget.example/w]\n  - button "Shadow click" [ref=e5]');
    await run(d.value, { action: "click", tabId: 1, ref: "e5" });
    // Same backend node id as the main page's "Send order" button, but no confirmation: it is the iframe's button.
    expect(mouseDown(chrome.sent)).toEqual([expect.objectContaining({ sessionId: "s1", params: expect.objectContaining({ x: 110, y: 110 }) })]);
    const text = await run(d.value, { action: "read_text", tabId: 1 });
    expect(text.text).toContain("page text\n\n--- iframe https://widget.example/w ---\nWidget text");
    // A text read and a screenshot name their page, as a snapshot does, so its page guide can join them.
    expect(text.pageUrl).toBe("https://shop.example/checkout");
    expect((await run(d.value, { action: "screenshot", tabId: 1 })).pageUrl).toBe("https://shop.example/checkout");
  });

  it("says when controls without an ARIA role may be missing because their discovery failed", async () => {
    const ok = fakeChrome();
    expect((await run(deps(ok.api, null).value, { action: "snapshot", tabId: 1 })).text).not.toMatch(/may be missing/);
    expect(ok.sent.some(item => item.method === "Runtime.releaseObjectGroup")).toBe(true);
    const failing = fakeChrome({ discoveryFails: true });
    const snapshot = await run(deps(failing.api, null).value, { action: "snapshot", tabId: 1 });
    expect(snapshot.text).toContain('button "Send order"');
    expect(snapshot.text).toMatch(/without an ARIA role failed; clickable cards or custom dropdowns may be missing/);
  });

  it("reports a control covered at its click point instead of clicking the overlay", async () => {
    const chrome = fakeChrome({ covering: { tag: "div", role: "dialog", name: "Accept cookies" } });
    const d = deps(chrome.api, null);
    await run(d.value, { action: "snapshot", tabId: 1 });
    await expect(run(d.value, { action: "click", tabId: 1, ref: "e4" })).rejects.toMatchObject({ code: "TARGET_OBSCURED",
      message: expect.stringContaining('covered by <div role=dialog> "Accept cookies"') });
    expect(mouseDown(chrome.sent)).toHaveLength(0);
  });

  it("names the tab a click opened in the click's result", async () => {
    const chrome = fakeChrome({ clickOpens: "https://shop.example/details" });
    const d = deps(chrome.api, null);
    await run(d.value, { action: "snapshot", tabId: 1 });
    const result = await run(d.value, { action: "click", tabId: 1, ref: "e4" });
    expect(result.text).toContain('Opened new tab tabId=10 "Details" https://shop.example/details.');
  });

  it("opens a tab in the user's window, behind their current tab, when Settings say This window", async () => {
    const chrome = fakeChrome();
    Object.assign(chrome.tabs[0], { index: 3, windowId: 5 });
    const d = deps(chrome.api, null);
    const created = () => chrome.sent.filter(item => item.method === "tabs.create").map(item => item.params);
    // The default (no window chosen): no user window is named, the opened tab is shown in its own window.
    await run({ ...d.value, workWindow: async () => undefined }, { action: "open", url: "https://news.example/" });
    expect(created()).toEqual([{ url: "https://news.example/", active: true }]);
    const result = await run({ ...d.value, workWindow: async () => 5 }, { action: "open", url: "https://docs.example/" });
    expect(created()[1]).toEqual({ windowId: 5, url: "https://docs.example/", active: false, index: 4, openerTabId: 1 });
    expect(result.text).toMatch(/^Opened tabId=9 /);
    // Opening leaves the user's current tab shown; nothing was activated.
    expect(chrome.sent.some(item => item.method === "tabs.update")).toBe(false);
  });

  it("closes a tab it opened on a page that did not load, and reports why; a page that loaded stays open", async () => {
    for (const [load, reason] of [[{ status: 404, text: 22 }, "HTTP 404"], [{ status: 0, errorPage: true }, "could not be reached"],
      [{ status: 200, text: 0, elements: 0 }, "empty"]] as const) {
      const chrome = fakeChrome({ load });
      const failed = run(deps(chrome.api, null).value, { action: "open", url: "https://site.example/guess.png" });
      await expect(failed).rejects.toMatchObject({ code: "PAGE_LOAD_FAILED", message: expect.stringContaining(reason) });
      expect(chrome.sent.filter(item => item.method === "tabs.remove")).toEqual([{ method: "tabs.remove", params: { id: 9 } }]);
      expect(chrome.tabs.some(tab => tab.id === 9)).toBe(false);
    }
    // An image, a page of controls without text, and a login or bot check the user may act on have loaded.
    for (const load of [{ status: 200, text: 0, elements: 1 }, { status: 200, type: "application/pdf", text: 0, elements: 0 }, { status: 401 }, { status: 403 }, { status: 503 }]) {
      const chrome = fakeChrome({ load });
      expect((await run(deps(chrome.api, null).value, { action: "open", url: "https://site.example/puzzle.png" })).text).toMatch(/^Opened tabId=9 /);
      expect(chrome.sent.some(item => item.method === "tabs.remove")).toBe(false);
    }
  });

  it("reports a navigation to a page that did not load, and leaves the tab where it is", async () => {
    const chrome = fakeChrome({ load: { status: 410 } });
    await expect(run(deps(chrome.api, null).value, { action: "navigate", tabId: 1, url: "https://shop.example/missing" }))
      .rejects.toMatchObject({ code: "PAGE_LOAD_FAILED", message: expect.stringContaining("HTTP 410") });
    expect(chrome.sent.some(item => item.method === "tabs.remove")).toBe(false);
  });

  it("brings a background tab to the front, with focus emulation, before input reaches it", async () => {
    const chrome = fakeChrome();
    chrome.tabs[0].active = false;
    const d = deps(chrome.api, null);
    await run(d.value, { action: "snapshot", tabId: 1 });
    expect(chrome.sent.some(item => item.method === "tabs.update")).toBe(false); // reads leave the tab where it is
    await run(d.value, { action: "click", tabId: 1, ref: "e4" });
    const methods = chrome.sent.map(item => item.method === "Input.dispatchMouseEvent" ? `mouse:${item.params?.type}` : item.method);
    const front = methods.indexOf("tabs.update");
    expect(front).toBeGreaterThanOrEqual(0);
    expect(methods.indexOf("Emulation.setFocusEmulationEnabled")).toBeGreaterThan(front);
    expect(methods.indexOf("mouse:mousePressed")).toBeGreaterThan(front);
  });

  it("scrolls the document by script, and falls back to a wheel event when it does not move", async () => {
    const chrome = fakeChrome();
    const d = deps(chrome.api, null);
    expect((await run(d.value, { action: "scroll", tabId: 1, direction: "down" })).text).toBe("Scrolled down. scrollY=480 of 2000 (viewport 600).");
    expect(chrome.sent.some(item => item.params?.type === "mouseWheel")).toBe(false);
  });

  it("looks into the focused iframe to decide whether Enter needs the user's approval", async () => {
    const keyDowns = (sent: { method: string; params?: Record<string, unknown> }[]) => sent.filter(item => item.method === "Input.dispatchKeyEvent" && item.params?.type === "keyDown");
    const plain = fakeChrome({ oopif: true, mainFocus: { role: "iframe", name: "Widget" }, childFocus: { role: "button", name: "Shadow click", inForm: false } });
    const result = await run(deps(plain.api, null).value, { action: "press", tabId: 1, key: "Enter" });
    expect(result.text).toBe('Pressed Enter in button "Shadow click".');
    expect(keyDowns(plain.sent)).toHaveLength(1);

    const submit = fakeChrome({ oopif: true, mainFocus: { role: "iframe", name: "Widget" }, childFocus: { role: "button", name: "Submit", inForm: true } });
    const declined = deps(submit.api, false);
    await expect(run(declined.value, { action: "press", tabId: 1, key: "Enter" })).rejects.toMatchObject({ code: "USER_DECLINED" });
    expect(declined.asked).toEqual(['press Enter on button "Submit"']);
    expect(keyDowns(submit.sent)).toHaveLength(0);
  });

  it("clicks an ordinary link without asking", async () => {
    const chrome = fakeChrome();
    const d = deps(chrome.api, null);
    await run(d.value, { action: "snapshot", tabId: 1 });
    // The fake reports every node as inside a form; links are not form buttons, so no question.
    await run(d.value, { action: "click", tabId: 1, ref: "e4" });
    expect(mouseDown(chrome.sent)).toHaveLength(1);
  });

  it("refuses to type into a password field", async () => {
    const chrome = fakeChrome();
    const d = deps(chrome.api, null);
    const snapshot = await run(d.value, { action: "snapshot", tabId: 1 });
    expect(snapshot.text).not.toContain("hunter2");
    await expect(run(d.value, { action: "type", tabId: 1, ref: "e2", text: "secret" })).rejects.toMatchObject({ code: "PROTECTED_FIELD" });
    expect(chrome.sent.some(item => item.method === "Input.insertText")).toBe(false);
  });

  it("refuses input on a page with a human-verification challenge", async () => {
    const chrome = fakeChrome({ frames: ["https://www.google.com/recaptcha/api2/anchor"] });
    const d = deps(chrome.api, null);
    await run(d.value, { action: "snapshot", tabId: 1 });
    await expect(run(d.value, { action: "click", tabId: 1, ref: "e4" })).rejects.toMatchObject({ code: "HUMAN_VERIFICATION" });
  });

  it("invalidates refs after the document changes", async () => {
    const chrome = fakeChrome();
    const d = deps(chrome.api, null);
    await run(d.value, { action: "snapshot", tabId: 1 });
    chrome.navigate();
    await expect(run(d.value, { action: "click", tabId: 1, ref: "e4" })).rejects.toMatchObject({ code: "REF_STALE" });
    await expect(run(d.value, { action: "click", tabId: 1, ref: "e4" })).rejects.toMatchObject({ code: "REF_UNKNOWN" });
  });

  it("controls only ordinary non-incognito http(s) tabs", async () => {
    const chrome = fakeChrome();
    const d = deps(chrome.api, null);
    expect((await run(d.value, { action: "tabs" })).text).toBe('tabId=1 [active] "Shop" https://shop.example/checkout');
    await expect(run(d.value, { action: "snapshot", tabId: 2 })).rejects.toMatchObject({ code: "TAB_NOT_ALLOWED" });
    await expect(run(d.value, { action: "read_text", tabId: 3 })).rejects.toMatchObject({ code: "TAB_NOT_ALLOWED" });
    await expect(run(d.value, { action: "snapshot", tabId: 99 })).rejects.toMatchObject({ code: "TAB_NOT_FOUND" });
  });

  it("cannot send CDP methods outside the allowlist, such as cookie reads", async () => {
    const chrome = fakeChrome();
    await expect(withTab(chrome.api, 1, send => send("Network.getCookies"))).rejects.toMatchObject({ code: "CDP_METHOD_BLOCKED" });
    await expect(withTab(chrome.api, 1, send => send("Storage.getCookies"))).rejects.toMatchObject({ code: "CDP_METHOD_BLOCKED" });
    expect(chrome.sent.some(item => /Cookie/.test(item.method))).toBe(false);
  });

  it("reads a PDF tab through the Worker by its URL alone, and an ordinary page locally", async () => {
    const chrome = fakeChrome({ tabUrl: "https://papers.example/a.pdf#page=2", pdf: true });
    const d = deps(chrome.api, null, () => ({ ok: true, pages: 3, from: 2, text: "--- page 2 ---\nBeta method\n\n--- page 3 ---\nGamma results" }));
    const result = await run(d.value, { action: "read_text", tabId: 1, maxChars: 5_000 });
    expect(d.pdfRequests).toEqual([{ url: "https://papers.example/a.pdf#page=2", maxChars: 5_000 }]);
    expect(result.text).toMatch(/PDF with 3 pages, text from page 2/);
    expect(result.text).toContain("--- page 2 ---\nBeta method");
    // Nothing is read from or run in the PDF tab itself.
    expect(chrome.sent.map(item => item.method)).toEqual(["Page.getFrameTree"]);

    const beyond = deps(fakeChrome({ tabUrl: "https://papers.example/a.pdf#page=9", pdf: true }).api, null, () => ({ ok: true, pages: 3, from: 9, text: "" }));
    expect((await run(beyond.value, { action: "read_text", tabId: 1 })).text).toMatch(/3 pages; there is no page 9/);

    const unsplit = deps(fakeChrome({ tabUrl: "https://papers.example/a.pdf#page=2", pdf: true }).api, null, () => ({ ok: true, pages: null, from: 2, text: "All the text" }));
    expect((await run(unsplit.value, { action: "read_text", tabId: 1 })).text).toMatch(/without page boundaries .*#page=2 could not be applied[^]*All the text/);

    const page = deps(fakeChrome().api, null);
    expect((await run(page.value, { action: "read_text", tabId: 1 })).text).toContain("page text");
    expect(page.pdfRequests).toEqual([]);
  });

  it("says why a PDF's text is unavailable: not fetchable, not convertible, or the Worker unreachable", async () => {
    const tab = () => fakeChrome({ tabUrl: "https://papers.example/private.pdf", pdf: true }).api;
    const fetchFailed = deps(tab(), null, () => ({ ok: false, stage: "fetch", reason: "HTTP 403: the PDF needs a login or is restricted" }));
    await expect(run(fetchFailed.value, { action: "read_text", tabId: 1 }))
      .rejects.toMatchObject({ code: "PDF_TEXT_UNAVAILABLE", message: expect.stringMatching(/HTTP 403[^]*without the user's cookies/) });
    const convertFailed = deps(tab(), null, () => ({ ok: false, stage: "convert", reason: "the conversion failed: bad xref" }));
    await expect(run(convertFailed.value, { action: "read_text", tabId: 1 }))
      .rejects.toMatchObject({ code: "PDF_TEXT_UNAVAILABLE", message: expect.stringMatching(/bad xref[^]*Do not click or type in the viewer/) });
    const offline = deps(tab(), null, () => { throw Object.assign(new Error("NETWORK_ERROR"), { code: "NETWORK_ERROR" }); });
    await expect(run(offline.value, { action: "read_text", tabId: 1 }))
      .rejects.toMatchObject({ code: "PDF_TEXT_UNAVAILABLE", message: expect.stringMatching(/NETWORK_ERROR/) });
  });

  it("refuses clicks, keys and typing on Chrome's PDF viewer before sending anything, but scrolls", async () => {
    const chrome = fakeChrome({ tabUrl: "https://papers.example/a.pdf", pdf: true });
    const d = deps(chrome.api, null);
    await run(d.value, { action: "snapshot", tabId: 1 });
    const before = chrome.sent.length;
    await expect(run(d.value, { action: "click", tabId: 1, ref: "e4" })).rejects.toMatchObject({ code: "PDF_VIEWER_INPUT", message: expect.stringMatching(/#page=N/) });
    await expect(run(d.value, { action: "type", tabId: 1, ref: "e1", text: "hi" })).rejects.toMatchObject({ code: "PDF_VIEWER_INPUT" });
    await expect(run(d.value, { action: "press", tabId: 1, key: "PageDown" })).rejects.toMatchObject({ code: "PDF_VIEWER_INPUT" });
    expect(chrome.sent.slice(before).map(item => item.method)).toEqual(["Page.getFrameTree", "Page.getFrameTree", "Page.getFrameTree"]);

    expect((await run(d.value, { action: "scroll", tabId: 1, direction: "down" })).text).toMatch(/^Scrolled down/);
    expect(chrome.sent.some(item => item.method === "Input.dispatchMouseEvent" && item.params?.type === "mouseWheel")).toBe(true);
  });

  it("treats a debugger detach during navigation as arrival when the tab shows the requested PDF", async () => {
    const url = "https://papers.example/a.pdf#page=3";
    const arrived = fakeChrome({ detachOnNavigate: url });
    const result = await run(deps(arrived.api, null).value, { action: "navigate", tabId: 1, url });
    expect(result.text).toContain(`Navigated tabId=1 to ${url}`);

    const elsewhere = fakeChrome({ detachOnNavigate: "https://login.example/" });
    await expect(run(deps(elsewhere.api, null).value, { action: "navigate", tabId: 1, url }))
      .rejects.toMatchObject({ code: "BROWSER_DETACHED" });
  });
});
