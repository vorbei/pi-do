// The side panel's shell: agent-core's panel header (the Chat control at the top left with the
// connection status after it, Routine and Settings in the "…" menu, the version as its last line)
// over three views that fill the rest of the panel: the chat, the Routine view and Settings.
import { bindPanelHeader, markPanelView, panelHeaderMarkup } from "agent-core/ui";

export type PanelView = "chat" | "routines" | "settings";

// Lucide calendar-clock, as X Gardener's Routine entry.
const ROUTINE_ICON = '<svg viewBox="0 0 24 24"><path d="M21 7.5V6a2 2 0 0 0-2-2H5a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h3.5M16 2v4M8 2v4m-5 4h5"/><path d="M17.5 17.5 16 16.3V14"/><circle cx="16" cy="16" r="6"/></svg>';
const SETTINGS_ICON = '<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z"/></svg>';

export interface Shell {
  header: HTMLElement;
  /** The chat's mount point: the conversation and the composer under it. */
  chat: HTMLElement;
  /** The Routine view's mount point (agent-core's Routine list and editor). */
  routines: HTMLElement;
  settings: HTMLElement;
  status: HTMLElement;
  /** The Chat control and the element its thread list opens in. */
  menu: { trigger: HTMLElement; root: HTMLElement };
  show(view: PanelView): void;
}

/** Builds the shell in `panel`; `onView` decides which view a header control shows. */
export function mountShell(panel: HTMLElement, { version, onView }: { version: string; onView(view: PanelView): void }): Shell {
  panel.classList.add("chat-panel");
  panel.innerHTML = `${panelHeaderMarkup({
    status: '<span id="status" class="panel-status" role="status"></span>',
    chat: { triggerId: "chats", menuId: "chat-menu" },
    more: { label: "More", items: [{ view: "routines", label: "Routine", icon: ROUTINE_ICON }, { view: "settings", label: "Settings", icon: SETTINGS_ICON }],
      note: `Pi Browser Agent ${version}` },
  })}<main class="chat-panel-main"><div id="chat" class="chat-panel-view"></div><section id="routines" class="chat-panel-view" aria-label="Routines" hidden></section><section id="settings" class="chat-panel-view settings-view" aria-label="Settings" hidden></section></main>`;
  const $ = (selector: string) => panel.querySelector<HTMLElement>(selector)!;
  const shell: Shell = {
    header: $(".chat-panel-header"), chat: $("#chat"), routines: $("#routines"), settings: $("#settings"), status: $("#status"),
    menu: { trigger: $("#chats"), root: $("#chat-menu") },
    show(view) {
      shell.chat.hidden = view !== "chat";
      shell.routines.hidden = view !== "routines";
      shell.settings.hidden = view !== "settings";
      markPanelView(shell.header, view);
    },
  };
  bindPanelHeader(shell.header, { onView: view => onView(view as PanelView) });
  return shell;
}
