// pi-do's CDP policy over the shared transport (packages/agent-core): the only methods the extension
// may send — nothing here can read cookies, storage or credentials — and the agent window's key.
import { withTab, type AgentWindowConfig, type ChromeApi, type Send } from "agent-core/browser";

export { BrowserCoreError as BrowserError } from "agent-core/browser";
export type { ChromeApi, Send };

export const ALLOWED_CDP_METHODS: ReadonlySet<string> = new Set([
  "Page.enable", "Page.navigate", "Page.getFrameTree", "Page.captureScreenshot", "Page.getLayoutMetrics", "Page.createIsolatedWorld",
  "DOM.enable", "DOM.getDocument", "DOM.describeNode", "DOM.resolveNode", "DOM.focus", "DOM.getBoxModel", "DOM.scrollIntoViewIfNeeded", "DOM.getFrameOwner",
  "Accessibility.enable", "Accessibility.getFullAXTree",
  "Runtime.evaluate", "Runtime.callFunctionOn", "Runtime.getProperties", "Runtime.releaseObject", "Runtime.releaseObjectGroup",
  "Input.dispatchMouseEvent", "Input.dispatchKeyEvent", "Input.insertText",
  "Target.setAutoAttach", "Emulation.setFocusEmulationEnabled",
]);

export const AGENT_WINDOW: AgentWindowConfig = { storageKey: "agentWindowId" };

/** Runs `work` with the tab attached under pi-do's allowlist; calls on one tab never interleave. */
export function onTab<T>(api: ChromeApi, tabId: number, work: (send: Send) => Promise<T>): Promise<T> {
  return withTab(api, tabId, work, { allowedMethods: ALLOWED_CDP_METHODS, idleDetachMs: 30_000 });
}
