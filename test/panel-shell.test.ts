import { afterEach, describe, expect, it } from "vitest";
import { mountShell, type PanelView } from "../src/ext/shell.ts";
import { browserGlobals } from "./helpers/dom.ts";

describe("the side panel's shell", () => {
  let env: ReturnType<typeof browserGlobals>;
  afterEach(() => env.restore());

  function mount() {
    env = browserGlobals("<html><body><aside id=\"panel\"></aside></body></html>");
    const views: PanelView[] = [];
    const shell = mountShell(env.document.getElementById("panel")!, { version: "0.1.6", onView: view => { views.push(view); shell.show(view); } });
    return { shell, views, panel: env.document.getElementById("panel")! };
  }

  it("puts the thread list's Chat control at the top left and Routine and Settings in the … menu at the right", () => {
    const { shell, panel } = mount();
    // One header (no second title), then the views that fill the rest of the panel.
    expect([...panel.children].map(child => child.tagName)).toEqual(["DIV", "MAIN"]);
    expect(panel.querySelectorAll("header, h1").length).toBe(0);
    const [lead, more] = [...shell.header.children];
    expect(lead.querySelector("button")).toBe(shell.menu.trigger);
    expect(shell.menu.trigger.textContent).toBe("Chat");
    expect(shell.menu.trigger.getAttribute("aria-haspopup")).toBe("menu");
    expect(lead.contains(shell.menu.root)).toBe(true);
    expect(lead.contains(shell.status)).toBe(true);
    expect(more.tagName).toBe("DETAILS");
    expect([...more.querySelectorAll("[data-view]")].map(item => item.textContent)).toEqual(["Routine", "Settings"]);
    expect(more.textContent).toContain("Pi Browser Agent 0.1.6");
    expect([...panel.querySelectorAll("main > *")]).toEqual([shell.chat, shell.routines, shell.settings]);
  });

  it("shows Settings from the … menu and the chat again from the Chat control", () => {
    const { shell, views } = mount();
    shell.show("chat");
    const more = shell.header.querySelector("details")!;
    more.setAttribute("open", "");
    env.fire(shell.header.querySelector("[data-view=settings]")!, "click");
    expect(views).toEqual(["settings"]);
    expect([shell.chat.hidden, shell.routines.hidden, shell.settings.hidden]).toEqual([true, true, false]);
    expect(more.hasAttribute("open")).toBe(false);
    env.fire(shell.header.querySelector("[data-view=routines]")!, "click");
    expect([shell.chat.hidden, shell.routines.hidden, shell.settings.hidden]).toEqual([true, false, true]);
    env.fire(shell.menu.trigger, "click");
    expect(views).toEqual(["settings", "routines", "chat"]);
    expect([shell.chat.hidden, shell.routines.hidden, shell.settings.hidden]).toEqual([false, true, true]);
    expect(shell.menu.trigger.getAttribute("aria-selected")).toBe("true");
  });
});
