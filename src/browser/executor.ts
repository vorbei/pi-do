// Runs one validated browser call in the user's Chrome and returns the model-facing result.
// Hard guards live here, not in the prompt: http(s) tabs only, no incognito, no input on
// human-verification challenges or Chrome's PDF viewer, no typing into credential fields, and a
// user confirmation before any action that commits something outside the browser session.
import {
  confirmationReason, httpUrl, MAX_RESULT_TEXT, type BrowserCall, type BrowserResult, type PdfTextRequest, type PdfTextResponse, type TargetSummary,
} from "../shared/protocol.ts";
import { AGENT_WINDOW, BrowserError, onTab as withTab, type ChromeApi, type Send } from "./cdp.ts";
import {
  childFrameId, createAgentTab, describeOpenedTabs, evaluateInFrame, findClickables, frameDocuments, isPdfViewer, nodeClickPoint,
  obscuredMessage, pdfViewerInputMessage, prepareInput, sameDocument, scrollPage, selectOptions, settledHitTest, watchOpenedTabs, type FrameDoc, type FrameTree,
} from "agent-core/browser";
import {
  axText, EDITABLE_ROLES, filterSnapshot, FRAME_ROLES, interactiveOnly, projectSnapshot, resolveControl, shownName, shownRole,
  type AXNode, type FrameNodes, type StoredControl,
} from "./snapshot.ts";

export interface ConfirmRequest { reason: string; tabId: number; title: string; url: string; }
export interface ExecutorDeps {
  api: ChromeApi;
  /** Asks the user in the side panel; resolves true only on an explicit approval. */
  confirm(request: ConfirmRequest): Promise<boolean>;
  /** Reads a PDF tab's text on the Worker, which fetches the URL itself (no cookies, no page content sent). */
  pdfText(request: PdfTextRequest): Promise<PdfTextResponse>;
  /**
   * The window the user chose for the agent's new tabs ("This window" in Settings), or undefined
   * for the agent's own unfocused window (the default).
   */
  workWindow?(): Promise<number | undefined>;
  sleep?: (ms: number) => Promise<void>;
}

// Refs of the latest snapshot per tab, bound to the main document and to each frame's document (loaderIds).
const refStore = new Map<number, { documentId: string; frames: Map<string, string>; refs: Record<string, StoredControl> }>();
const HUMAN_VERIFICATION = /recaptcha|hcaptcha\.com|challenges\.cloudflare\.com|turnstile|captcha/i;
const PROTECTED_AUTOCOMPLETE = /(^|\s)(current-password|new-password|one-time-code|cc-number|cc-csc|cc-exp)(\s|$)/i;
const DEFAULT_READ_CHARS = 20_000;

export async function executeBrowserCall(deps: ExecutorDeps, call: BrowserCall): Promise<BrowserResult> {
  const { api } = deps;
  switch (call.action) {
    case "tabs": {
      const tabs = (await api.tabs.query({})).filter(tab => !tab.incognito && tab.id !== undefined && httpUrl(tab.url ?? ""));
      return { text: tabs.length
        ? tabs.map(tab => `tabId=${tab.id}${tab.active ? " [active]" : ""} ${JSON.stringify(tab.title ?? "")} ${tab.url}`).join("\n")
        : "No controllable http(s) tabs are open." };
    }
    case "open": {
      // In the user's window the tab opens behind the one they are on; input brings it to the front.
      const windowId = await deps.workWindow?.();
      const tab = await createAgentTab(api, { url: requireHttp(call.url!), ...(windowId !== undefined ? { windowId, active: false } : {}) }, AGENT_WINDOW);
      const loaded = await waitForTabLoad(deps, tab.id!);
      // A tab the agent opened on a page that did not load is closed again, not left behind.
      const failure = await loadFailure(deps, tab.id!);
      if (failure) {
        await api.tabs.remove(tab.id!).catch(() => {});
        throw new BrowserError("PAGE_LOAD_FAILED", `${call.url}: ${failure}. The tab was closed.`);
      }
      return { text: `Opened tabId=${tab.id} ${JSON.stringify(loaded.title ?? "")} ${loaded.url ?? call.url}`, ...pageUrl(loaded.url) };
    }
    case "select_tab": {
      await controllableTab(api, call.tabId!);
      const tab = await api.tabs.update(call.tabId!, { active: true });
      return { text: `Selected tabId=${call.tabId} ${JSON.stringify(tab?.title ?? "")} ${tab?.url ?? ""}` };
    }
    case "navigate": {
      await controllableTab(api, call.tabId!);
      const url = requireHttp(call.url!);
      await withTab(api, call.tabId!, async send => {
        const result = await send<{ errorText?: string }>("Page.navigate", { url });
        if (result.errorText) throw new BrowserError("NAVIGATION_FAILED", result.errorText);
        await waitForReady(deps, send);
      }).catch(async error => {
        // Chrome's PDF viewer detaches the debugger as the PDF commits: a tab that already
        // shows the requested URL has arrived.
        if ((error as BrowserError).code !== "BROWSER_DETACHED" || !sameDocument((await api.tabs.get(call.tabId!)).url ?? "", url)) throw error;
      });
      refStore.delete(call.tabId!);
      const failure = await loadFailure(deps, call.tabId!);
      if (failure) throw new BrowserError("PAGE_LOAD_FAILED", `${url}: ${failure}.`);
      const tab = await api.tabs.get(call.tabId!);
      return { text: `Navigated tabId=${call.tabId} to ${tab.url} ${JSON.stringify(tab.title ?? "")}. Take a snapshot before acting.`, ...pageUrl(tab.url) };
    }
    case "snapshot": return snapshot(deps, call);
    case "click": return click(deps, call);
    case "type": return type(deps, call);
    case "select": return select(deps, call);
    case "press": return press(deps, call);
    case "scroll": {
      const tab = await controllableTab(api, call.tabId!);
      const position = await withTab(api, tab.id!, async send => {
        await prepareInput(api, tab, send, deps.sleep ?? sleep);
        // The document scrolls by script, or the open dialog's list when the document is
        // scroll-locked; otherwise, and in the PDF viewer, a wheel event at the viewport's center
        // (agent-core scrollPage).
        const metrics = await send<{ cssVisualViewport: { clientHeight: number } }>("Page.getLayoutMetrics");
        const dy = (call.direction === "up" ? -1 : 1) * Math.round(metrics.cssVisualViewport.clientHeight * 0.8);
        return scrollPage(send, { dy, screen: 0.8, wheel: await isPdfViewer(send), sleep: deps.sleep ?? sleep });
      });
      const where = position.scroller ? ` ${position.scroller}` : "";
      return { text: `Scrolled${where} ${call.direction}. scrollY=${position.scrollY} of ${position.scrollHeight} (viewport ${position.viewportHeight}).` };
    }
    case "read_text": {
      const tab = await controllableTab(api, call.tabId!);
      const limit = call.maxChars ?? DEFAULT_READ_CHARS;
      const text = await withTab(api, tab.id!, async send => await isPdfViewer(send) ? null : pageText(tab.id!, send));
      if (text === null) return readPdf(deps, tab, limit);
      return { text: `${header(tab)}\n${cut(text, limit)}`.slice(0, MAX_RESULT_TEXT), ...pageUrl(tab.url) };
    }
    case "screenshot": {
      const tab = await controllableTab(api, call.tabId!);
      const shot = await withTab(api, tab.id!, send => send<{ data: string }>("Page.captureScreenshot", { format: "jpeg", quality: 60 }));
      return { text: `${header(tab)}\nScreenshot of the visible viewport.`, image: { data: shot.data, mimeType: "image/jpeg" }, ...pageUrl(tab.url) };
    }
  }
}

async function snapshot(deps: ExecutorDeps, call: BrowserCall): Promise<BrowserResult> {
  const tab = await controllableTab(deps.api, call.tabId!);
  const result = await withTab(deps.api, tab.id!, async send => {
    const docs = await frameDocuments(send);
    const documentId = docs[0].loaderId;
    const frames: FrameNodes[] = [];
    let cursorDiscoveryFailed = false;
    for (const doc of docs) {
      const nodes = await frameAxTree(send, doc);
      if (!nodes) continue;
      const owners = new Map<number, string>();
      const protectedNodes = new Set<number>();
      for (const node of nodes) {
        if (node.ignored || !node.backendDOMNodeId) continue;
        const role = axText(node.role);
        if (FRAME_ROLES.has(role)) {
          const childId = await childFrameId(send, node.backendDOMNodeId, doc.sessionId);
          if (childId) owners.set(node.backendDOMNodeId, childId);
        } else if (EDITABLE_ROLES.has(role) && await isProtectedNode(send, node.backendDOMNodeId, doc.sessionId)) {
          protectedNodes.add(node.backendDOMNodeId);
        }
      }
      const discovery = await findClickables(send, doc);
      cursorDiscoveryFailed ||= discovery.discoveryError !== null;
      frames.push({ frameId: doc.frameId, url: doc.url, nodes, owners, protectedNodes, clickables: new Map(discovery.clickables.map(item => [item.backendNodeId, item.label])) });
    }
    if (documentId !== await currentDocument(send)) throw new BrowserError("PAGE_CHANGED", "The page navigated during the snapshot; take it again");
    return { documentId, docs, cursorDiscoveryFailed, projected: projectSnapshot(frames, header(tab)) };
  });
  refStore.set(tab.id!, { documentId: result.documentId, frames: new Map(result.docs.map(doc => [doc.frameId, doc.loaderId])), refs: result.projected.refs });
  let text = result.projected.text;
  if (call.interactive) text = interactiveOnly(text);
  if (call.filter) text = filterSnapshot(text, call.filter);
  if (result.cursorDiscoveryFailed) text += "\nNote: finding controls without an ARIA role failed; clickable cards or custom dropdowns may be missing above.";
  return { text, ...pageUrl(tab.url) };
}

async function click(deps: ExecutorDeps, call: BrowserCall): Promise<BrowserResult> {
  const tab = await controllableTab(deps.api, call.tabId!);
  const target = await withTab(deps.api, tab.id!, async send => {
    await guardInput(tab.id!, send, tab);
    const { node, stored, frame } = await resolveRef(send, tab.id!, call.ref!);
    if (node.properties?.some(item => item.name === "disabled" && item.value.value === true)) throw new BrowserError("TARGET_DISABLED", `${shownRole(stored)} "${shownName(stored)}" is disabled`);
    const inForm = await nodeCall<boolean>(send, stored.backendNodeId, "function() { return !!(this.closest && this.closest('form')); }", frame.sessionId);
    return { stored, summary: { role: shownRole(stored), name: shownName(stored), inForm } satisfies TargetSummary };
  });
  await confirmIfNeeded(deps, tab, confirmationReason(call, target.summary, null));
  const opened = watchOpenedTabs(deps.api, deps.sleep ?? sleep);
  await withTab(deps.api, tab.id!, async send => {
    await prepareInput(deps.api, tab, send, deps.sleep ?? sleep);
    const { stored, frame } = await resolveRef(send, tab.id!, call.ref!);
    // In a cross-process iframe, the box and the mouse events are in that frame's own viewport.
    const session = frame.sessionId;
    const first = await nodeClickPoint(send, stored.backendNodeId, session);
    await send("Input.dispatchMouseEvent", { type: "mouseMoved", ...first }, session);
    // Nothing is pressed when the point lands on something else (a banner, a menu's backdrop). A
    // miss that scrolling caused (a sticky header, cells briefly without pointer events) is
    // re-centred and tested again.
    const hit = await settledHitTest(send, stored.backendNodeId, first, { sessionId: session, sleep: deps.sleep ?? sleep });
    if (!hit.hit) throw new BrowserError("TARGET_OBSCURED", `Nothing was clicked. ${obscuredMessage(hit)}`);
    const { x, y } = hit.point;
    await send("Input.dispatchMouseEvent", { type: "mousePressed", x, y, button: "left", clickCount: 1 }, session);
    await send("Input.dispatchMouseEvent", { type: "mouseReleased", x, y, button: "left", clickCount: 1 }, session);
    await (deps.sleep ?? sleep)(500);
  }).catch(async error => { await opened.stop(); throw error; });
  const newTabs = await opened.stop();
  const after = await deps.api.tabs.get(tab.id!);
  return { text: `Clicked ${shownRole(target.stored)} ${JSON.stringify(shownName(target.stored))}. Tab now: ${JSON.stringify(after.title ?? "")} ${after.url}.${describeOpenedTabs(newTabs)} Read the page to verify the effect.`, ...pageUrl(after.url) };
}

async function type(deps: ExecutorDeps, call: BrowserCall): Promise<BrowserResult> {
  const tab = await controllableTab(deps.api, call.tabId!);
  const { stored, frame } = await withTab(deps.api, tab.id!, async send => {
    await guardInput(tab.id!, send, tab);
    const { stored, frame } = await resolveRef(send, tab.id!, call.ref!);
    const editable = EDITABLE_ROLES.has(stored.role)
      || await nodeCall<boolean>(send, stored.backendNodeId, "function() { return !!this.isContentEditable; }", frame.sessionId);
    if (!editable) throw new BrowserError("TARGET_NOT_EDITABLE", `${shownRole(stored)} "${shownName(stored)}" is not a text field`);
    if (await isProtectedNode(send, stored.backendNodeId, frame.sessionId)) {
      throw new BrowserError("PROTECTED_FIELD", "Typing into password, one-time-code or payment fields is not allowed; ask the user to fill it in");
    }
    return { stored, frame };
  });
  await confirmIfNeeded(deps, tab, confirmationReason(call, { role: shownRole(stored), name: shownName(stored) }, null));
  await withTab(deps.api, tab.id!, async send => {
    await prepareInput(deps.api, tab, send, deps.sleep ?? sleep);
    const session = frame.sessionId;
    await send("DOM.focus", { backendNodeId: stored.backendNodeId }, session);
    await nodeCall(send, stored.backendNodeId, `function() {
      if ('value' in this) { this.value = ''; this.dispatchEvent(new Event('input', { bubbles: true })); }
      else if (this.isContentEditable) { const range = this.ownerDocument.createRange(); range.selectNodeContents(this);
        const selection = this.ownerDocument.getSelection(); selection.removeAllRanges(); selection.addRange(range); this.ownerDocument.execCommand('delete'); }
    }`, session);
    await send("Input.insertText", { text: call.text }, session);
    if (call.submit) await dispatchKey(send, "Enter", session);
    await (deps.sleep ?? sleep)(call.submit ? 500 : 100);
  });
  return { text: `Typed ${call.text!.length} characters into ${shownRole(stored)} ${JSON.stringify(shownName(stored))}${call.submit ? " and pressed Enter" : ""}.` };
}

/** Chooses an option of a native <select>; a custom dropdown is opened and chosen with clicks. */
async function select(deps: ExecutorDeps, call: BrowserCall): Promise<BrowserResult> {
  const tab = await controllableTab(deps.api, call.tabId!);
  const result = await withTab(deps.api, tab.id!, async send => {
    await guardInput(tab.id!, send, tab);
    const { stored, frame } = await resolveRef(send, tab.id!, call.ref!);
    try {
      const { chosen } = await selectOptions(send, stored.backendNodeId, [call.option!], frame.sessionId);
      return { stored, chosen: chosen.at(-1) ?? call.option! };
    } catch (error) {
      const { code, message } = error as BrowserError;
      throw code === "TARGET_NOT_SELECT" ? new BrowserError(code, `${shownRole(stored)} "${shownName(stored)}": ${message}`) : error;
    }
  });
  return { text: `Selected ${JSON.stringify(result.chosen)} in ${shownRole(result.stored)} ${JSON.stringify(shownName(result.stored))}.` };
}

async function press(deps: ExecutorDeps, call: BrowserCall): Promise<BrowserResult> {
  const tab = await controllableTab(deps.api, call.tabId!);
  const focused = await withTab(deps.api, tab.id!, async send => {
    await guardInput(tab.id!, send, tab);
    return focusedControl(send);
  });
  await confirmIfNeeded(deps, tab, confirmationReason(call, null, focused));
  const opened = watchOpenedTabs(deps.api, deps.sleep ?? sleep);
  await withTab(deps.api, tab.id!, async send => {
    await prepareInput(deps.api, tab, send, deps.sleep ?? sleep);
    await dispatchKey(send, call.key!);
    if (call.key === "Enter" || call.key === "Space") await (deps.sleep ?? sleep)(300);
  }).catch(async error => { await opened.stop(); throw error; });
  const newTabs = await opened.stop();
  return { text: `Pressed ${call.key}${focused ? ` in ${focused.role} ${JSON.stringify(focused.name)}` : ""}.${describeOpenedTabs(newTabs)}` };
}

// ---------------------------------------------------------------- guards and helpers

async function controllableTab(api: ChromeApi, tabId: number): Promise<chrome.tabs.Tab> {
  let tab: chrome.tabs.Tab;
  try { tab = await api.tabs.get(tabId); }
  catch { throw new BrowserError("TAB_NOT_FOUND", `No tab ${tabId}; list tabs to find the right one`); }
  if (tab.incognito) throw new BrowserError("TAB_NOT_ALLOWED", "Incognito tabs are not controlled");
  const url = httpUrl(tab.url ?? "");
  if (!url || /^https:\/\/chromewebstore\.google\.com\//.test(url)) throw new BrowserError("TAB_NOT_ALLOWED", `Tab ${tabId} is not an ordinary http(s) page`);
  return tab;
}

/**
 * Refuses input, before any input is sent, on Chrome's PDF viewer and on pages with a
 * human-verification challenge in any frame (cross-process iframes included).
 */
async function guardInput(tabId: number, send: Send, tab: chrome.tabs.Tab): Promise<void> {
  if (await isPdfViewer(send)) {
    throw new BrowserError("PDF_VIEWER_INPUT", pdfViewerInputMessage("read_text"));
  }
  const urls = [tab.url ?? "", ...(await frameDocuments(send)).map(doc => doc.url)];
  if (urls.some(url => HUMAN_VERIFICATION.test(url))) {
    throw new BrowserError("HUMAN_VERIFICATION", "This page shows a human-verification challenge. Only the user may complete it; ask them to.");
  }
}

// ---------------------------------------------------------------- PDF tabs

const PDF_FALLBACK = "Do not click or type in the viewer: take a screenshot of the shown page (navigate to the PDF URL with #page=N for page N), or tell the user the text is unavailable.";

/** The PDF's text, converted on the Worker from the tab's URL; nothing else about the tab is sent. */
async function readPdf(deps: ExecutorDeps, tab: chrome.tabs.Tab, limit: number): Promise<BrowserResult> {
  let pdf: PdfTextResponse;
  try { pdf = await deps.pdfText({ url: tab.url!, maxChars: limit }); }
  catch (error) {
    throw new BrowserError("PDF_TEXT_UNAVAILABLE", `This tab shows a PDF whose text could not be requested from the Worker (${(error as { code?: string }).code ?? (error as Error).message}). ${PDF_FALLBACK}`);
  }
  if (!pdf.ok) {
    throw new BrowserError("PDF_TEXT_UNAVAILABLE", pdf.stage === "fetch"
      ? `This tab shows a PDF that could not be fetched: ${pdf.reason}. The PDF is fetched by its URL without the user's cookies, so one behind a login is unreadable. ${PDF_FALLBACK}`
      : `This tab shows a PDF whose text could not be converted: ${pdf.reason}. ${PDF_FALLBACK}`);
  }
  const viewer = "The viewer takes no clicks or typing; navigate to #page=N to show page N.";
  if (pdf.pages === null) {
    const scope = pdf.from > 1 ? `, so #page=${pdf.from} could not be applied` : "";
    return { text: `${header(tab)}\nPDF text without page boundaries (the conversion reported none${scope}). ${viewer}\n${cut(pdf.text, limit)}`.slice(0, MAX_RESULT_TEXT) };
  }
  if (!pdf.text) return { text: `${header(tab)}\nPDF with ${pdf.pages} pages; there is no page ${pdf.from}.` };
  const scope = pdf.from > 1 ? `, text from page ${pdf.from}` : "";
  return { text: `${header(tab)}\nPDF with ${pdf.pages} pages${scope}. ${viewer}\n${cut(pdf.text, limit)}`.slice(0, MAX_RESULT_TEXT) };
}

// ---------------------------------------------------------------- documents and refs

async function currentDocument(send: Send): Promise<string> {
  return (await send<{ frameTree: FrameTree }>("Page.getFrameTree")).frameTree.frame.loaderId;
}

/** A frame's accessibility tree, or null when the frame cannot be read (gone, or not ready). */
async function frameAxTree(send: Send, doc: FrameDoc): Promise<AXNode[] | null> {
  try {
    await send("Accessibility.enable", {}, doc.sessionId);
    await send("DOM.enable", {}, doc.sessionId);
    return (await send<{ nodes: AXNode[] }>("Accessibility.getFullAXTree", { frameId: doc.frameId }, doc.sessionId)).nodes;
  } catch { return null; }
}

// The focused element of one document, as a confirmation target: its role (the explicit role, or
// one implied by the tag; a focusable element without a role is "clickable"), its name, and
// whether it sits in a form. A focused iframe element means focus is inside that frame.
const FOCUSED_SCRIPT = `(() => {
  const el = document.activeElement; if (!el || el === document.body || el === document.documentElement) return null;
  const tag = el.tagName.toLowerCase(), type = (el.getAttribute('type') || '').toLowerCase();
  const role = el.getAttribute('role') || (tag === 'iframe' || tag === 'frame' ? 'iframe' : type === 'search' ? 'searchbox' : tag === 'a' ? 'link'
    : tag === 'button' || (tag === 'input' && ['submit', 'button', 'reset', 'image'].includes(type)) ? 'button'
    : tag === 'select' ? 'combobox' : tag === 'input' || tag === 'textarea' || el.isContentEditable ? 'textbox'
    : el.hasAttribute('tabindex') ? 'clickable' : tag);
  const name = el.getAttribute('aria-label') || el.getAttribute('placeholder') || el.getAttribute('name') || el.getAttribute('title')
    || (tag === 'input' ? el.value : '') || (el.innerText || '').slice(0, 80);
  return { role, name: String(name).replace(/\\s+/g, ' ').trim(), inForm: !!(el.closest && el.closest('form')) };
})()`;

/**
 * The element keyboard input goes to. When the main document's focus is on an iframe, the
 * frame that holds the focus is read too; if it cannot be told, the target is an "iframe",
 * which the confirmation rule treats as unknown.
 */
async function focusedControl(send: Send): Promise<TargetSummary | null> {
  const main = await evaluate<TargetSummary | null>(send, FOCUSED_SCRIPT);
  if (main?.role !== "iframe") return main;
  const inner: TargetSummary[] = [];
  for (const doc of (await frameDocuments(send)).slice(1)) {
    const focused = await evaluateInFrame<TargetSummary | null>(send, doc, false, FOCUSED_SCRIPT);
    if (focused && focused.role !== "iframe") inner.push(focused);
  }
  return inner.length === 1 ? inner[0] : main;
}

/** The ref's control in its frame now, with the frame (and its session) to act through. */
async function resolveRef(send: Send, tabId: number, ref: string): Promise<{ node: AXNode; stored: StoredControl; frame: FrameDoc }> {
  const entry = refStore.get(tabId);
  const stored = entry?.refs[ref];
  if (!entry || !stored) throw new BrowserError("REF_UNKNOWN", `Ref ${ref} is not in the latest snapshot of tab ${tabId}; take a snapshot first`);
  const docs = await frameDocuments(send);
  if (docs[0].loaderId !== entry.documentId) {
    refStore.delete(tabId);
    throw new BrowserError("REF_STALE", "The page navigated since the snapshot; take a fresh snapshot");
  }
  const frame = docs.find(doc => doc.frameId === stored.frameId);
  if (!frame || frame.loaderId !== entry.frames.get(stored.frameId)) {
    throw new BrowserError("REF_STALE", "The iframe holding this control navigated or was removed since the snapshot; take a fresh snapshot");
  }
  const nodes = await frameAxTree(send, frame);
  if (!nodes) throw new BrowserError("REF_STALE", "The iframe holding this control cannot be read now; take a fresh snapshot");
  try {
    const node = resolveControl(nodes, stored);
    return { node, stored: { ...stored, backendNodeId: node.backendDOMNodeId! }, frame };
  } catch (error) {
    throw new BrowserError((error as { code?: string }).code ?? "REF_STALE", (error as Error).message);
  }
}

/** The visible text of the main frame, then of each iframe that has any, under a `--- iframe <url> ---` line. */
async function pageText(tabId: number, send: Send): Promise<string> {
  const docs = await frameDocuments(send);
  const parts: string[] = [];
  for (const [index, doc] of docs.entries()) {
    const text = (await evaluateInFrame<string>(send, doc, index === 0, "document.body ? document.body.innerText : ''"))?.trim() ?? "";
    if (index === 0) parts.push(text);
    else if (text) parts.push(`--- iframe ${doc.url.slice(0, 200)} ---\n${text}`);
  }
  return parts.join("\n\n");
}

async function isProtectedNode(send: Send, backendNodeId: number, sessionId?: string): Promise<boolean> {
  try {
    const { node } = await send<{ node: { nodeName?: string; attributes?: string[] } }>("DOM.describeNode", { backendNodeId }, sessionId);
    const attributes: Record<string, string> = {};
    for (let index = 0; index < (node.attributes ?? []).length; index += 2) attributes[node.attributes![index]] = node.attributes![index + 1] ?? "";
    return (String(node.nodeName).toUpperCase() === "INPUT" && attributes.type?.toLowerCase() === "password")
      || PROTECTED_AUTOCOMPLETE.test(attributes.autocomplete ?? "");
  } catch { return true; } // unverifiable fields are treated as protected
}

async function nodeCall<T>(send: Send, backendNodeId: number, functionDeclaration: string, sessionId?: string, args: unknown[] = []): Promise<T> {
  const { object } = await send<{ object: { objectId: string } }>("DOM.resolveNode", { backendNodeId }, sessionId);
  try {
    const result = await send<{ result: { value: T }; exceptionDetails?: unknown }>("Runtime.callFunctionOn",
      { objectId: object.objectId, functionDeclaration, returnByValue: true, arguments: args.map(value => ({ value })) }, sessionId);
    return result.result.value;
  } finally { await send("Runtime.releaseObject", { objectId: object.objectId }, sessionId).catch(() => {}); }
}

async function evaluate<T>(send: Send, expression: string, awaitPromise = false): Promise<T> {
  const result = await send<{ result: { value: T }; exceptionDetails?: { text?: string } }>("Runtime.evaluate", { expression, returnByValue: true, awaitPromise });
  if (result.exceptionDetails) throw new BrowserError("PAGE_SCRIPT_FAILED", result.exceptionDetails.text ?? "page evaluation failed");
  return result.result.value;
}

const KEYS: Record<string, { code: string; keyCode: number; text?: string }> = {
  Enter: { code: "Enter", keyCode: 13, text: "\r" }, Tab: { code: "Tab", keyCode: 9 }, Escape: { code: "Escape", keyCode: 27 },
  Backspace: { code: "Backspace", keyCode: 8 }, Delete: { code: "Delete", keyCode: 46 }, Space: { code: "Space", keyCode: 32, text: " " },
  ArrowUp: { code: "ArrowUp", keyCode: 38 }, ArrowDown: { code: "ArrowDown", keyCode: 40 }, ArrowLeft: { code: "ArrowLeft", keyCode: 37 },
  ArrowRight: { code: "ArrowRight", keyCode: 39 }, PageUp: { code: "PageUp", keyCode: 33 }, PageDown: { code: "PageDown", keyCode: 34 },
  Home: { code: "Home", keyCode: 36 }, End: { code: "End", keyCode: 35 },
};

async function dispatchKey(send: Send, key: string, sessionId?: string): Promise<void> {
  const spec = KEYS[key];
  const base = { key: key === "Space" ? " " : key, code: spec.code, windowsVirtualKeyCode: spec.keyCode, nativeVirtualKeyCode: spec.keyCode };
  await send("Input.dispatchKeyEvent", { type: spec.text ? "keyDown" : "rawKeyDown", ...base, ...(spec.text ? { text: spec.text } : {}) }, sessionId);
  await send("Input.dispatchKeyEvent", { type: "keyUp", ...base }, sessionId);
}

async function confirmIfNeeded(deps: ExecutorDeps, tab: chrome.tabs.Tab, reason: string | null): Promise<void> {
  if (!reason) return;
  const approved = await deps.confirm({ reason, tabId: tab.id!, title: tab.title ?? "", url: tab.url ?? "" });
  if (!approved) throw new BrowserError("USER_DECLINED", `The user declined: ${reason}. Do not retry it; ask the user what to do instead.`);
}

async function waitForTabLoad(deps: ExecutorDeps, tabId: number): Promise<chrome.tabs.Tab> {
  for (let elapsed = 0; elapsed < 15_000; elapsed += 250) {
    const tab = await deps.api.tabs.get(tabId);
    if (tab.status === "complete") return tab;
    await (deps.sleep ?? sleep)(250);
  }
  return deps.api.tabs.get(tabId);
}

// The loaded document's HTTP status (0 when unknown), whether it is Chrome's network-error page,
// and how much it shows: text characters and media or control elements.
const LOAD_PROBE = `(() => ({ status: performance.getEntriesByType("navigation")[0]?.responseStatus ?? 0,
  errorPage: location.protocol === "chrome-error:", type: document.contentType, text: (document.body?.innerText ?? "").trim().length,
  elements: document.querySelectorAll("img, video, canvas, svg, iframe, embed, object, input, button, a[href]").length }))()`;

/**
 * Why the tab's page did not load, or null: no page at that address (HTTP 404 or 410), Chrome's
 * error page (the host could not be reached), or a page with no text and nothing else to see
 * (checked again after a moment, for a page still rendering; only an HTML page: Chrome's PDF viewer
 * shows its document nothing to count). Other error statuses count as loaded:
 * a login (401), a bot check (403, 503) or a server's error page may be one the user acts on. A
 * page that cannot be inspected counts as loaded.
 */
async function loadFailure(deps: ExecutorDeps, tabId: number): Promise<string | null> {
  for (let attempt = 0; ; attempt++) {
    const probe = await withTab(deps.api, tabId, send => evaluate<unknown>(send, LOAD_PROBE)).catch(() => null) as
      { status?: number; errorPage?: boolean; type?: string; text?: number; elements?: number } | null;
    if (!probe || typeof probe !== "object") return null;
    if (probe.errorPage) return "the page could not be reached (Chrome shows its error page)";
    if (probe.status === 404 || probe.status === 410) return `HTTP ${probe.status}, no page at this address`;
    if (probe.text || probe.elements || !/html/.test(probe.type ?? "text/html")) return null;
    if (attempt) return "the page is empty";
    await (deps.sleep ?? sleep)(1_500);
  }
}

async function waitForReady(deps: ExecutorDeps, send: Send): Promise<void> {
  for (let elapsed = 0; elapsed < 15_000; elapsed += 250) {
    await (deps.sleep ?? sleep)(250);
    try { if (await evaluate<string>(send, "document.readyState") === "complete") return; }
    catch (error) { if ((error as BrowserError).code === "BROWSER_DETACHED") throw error; /* else still navigating */ }
  }
}


const cut = (text: string, limit: number) => text.length > limit ? `${text.slice(0, limit)}\n[cut at ${limit} of ${text.length} characters]` : text;

function requireHttp(url: string): string {
  return httpUrl(url) ?? (() => { throw new BrowserError("URL_NOT_ALLOWED", "Only http(s) URLs can be opened"); })();
}

/** The page a result is about, when it is an ordinary web page. */
const pageUrl = (url: string | undefined) => { const page = httpUrl(url ?? ""); return page ? { pageUrl: page } : {}; };

const header = (tab: chrome.tabs.Tab) => `Page: ${JSON.stringify(tab.title ?? "")} ${tab.url} (tabId=${tab.id})`;
const sleep = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));
