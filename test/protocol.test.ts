import { describe, expect, it } from "vitest";
import {
  ACTING_ACTIONS, confirmationReason, MAX_TURN_IMAGE_BASE64, MAX_TURN_IMAGES, parseBrowserCall, parseBrowserResult, parseRoutineRun, parseRoutineSave,
  parseRunCode, parseRunCodeResult, parseTabContext, parseTurnImages, RUN_CODE_LIMITS, RUN_CODE_MAX_CHARS,
} from "../src/shared/protocol.ts";

describe("browser call contract", () => {
  it.each([
    [{ action: "tabs" }, { action: "tabs" }],
    [{ action: "click", tabId: 3, ref: "@e12" }, { action: "click", tabId: 3, ref: "e12" }],
    [{ action: "snapshot", tabId: 3, filter: " price ", interactive: true }, { action: "snapshot", tabId: 3, filter: "price", interactive: true }],
    [{ action: "open", url: "https://example.com" }, { action: "open", url: "https://example.com/" }],
    [{ action: "select", tabId: 3, ref: "e4", option: "Canada" }, { action: "select", tabId: 3, ref: "e4", option: "Canada" }],
  ])("accepts %j", (input, expected) => {
    expect(parseBrowserCall(input)).toEqual(expected);
  });

  it.each([
    [{ action: "eval", tabId: 1 }, /action must be one of/],
    [{ action: "click", ref: "e1" }, /click requires tabId/],
    [{ action: "click", tabId: 1, ref: "#submit" }, /ref must look like e12/],
    [{ action: "navigate", tabId: 1, url: "javascript:alert(1)" }, /absolute http\(s\) URL/],
    [{ action: "navigate", tabId: 1, url: "file:///etc/passwd" }, /absolute http\(s\) URL/],
    [{ action: "press", tabId: 1, key: "Meta+Q" }, /key must be one of/],
    [{ action: "select", tabId: 1, ref: "e1" }, /select requires option/],
    [{ action: "type", tabId: 1, ref: "e1", text: "x".repeat(10_001) }, /at most 10000/],
  ])("rejects %j", (input, message) => {
    expect(() => parseBrowserCall(input)).toThrow(message);
  });

  it("bounds results and context", () => {
    expect(parseBrowserResult({ text: "x".repeat(70_000) }).text).toHaveLength(60_000);
    expect(() => parseBrowserResult({ text: "a", image: { data: "x", mimeType: "image/gif" } })).toThrow("INVALID_RESULT");
    expect(parseBrowserResult({ text: "a", pageUrl: "https://arxiv.org/search/advanced" }).pageUrl).toBe("https://arxiv.org/search/advanced");
    expect(() => parseBrowserResult({ text: "a", pageUrl: "chrome://settings" })).toThrow("INVALID_RESULT");
    expect(parseTabContext({ tabId: 1, url: "https://a.example/", title: "A" })).toEqual({ tabId: 1, url: "https://a.example/", title: "A" });
    expect(() => parseTabContext({ tabId: "1" })).toThrow("INVALID_CONTEXT");
  });
});

describe("run_code contract", () => {
  it("accepts js (the default) and bash with files, and trims nothing", () => {
    expect(parseRunCode({ code: " return 1 + 1; " })).toEqual({ language: "js", code: " return 1 + 1; " });
    expect(parseRunCode({ language: "bash", code: "sort words.txt | uniq -c", files: { "words.txt": "b\na\nb\n", "/data/x.json": "{}" } }))
      .toEqual({ language: "bash", code: "sort words.txt | uniq -c", files: { "words.txt": "b\na\nb\n", "/data/x.json": "{}" } });
  });

  it.each([
    [{}, /code must be/],
    [{ code: "   " }, /code must be/],
    [{ code: 42 }, /code must be/],
    [{ code: "x".repeat(RUN_CODE_MAX_CHARS + 1) }, /at most/],
    [{ code: "return 1;", url: "https://example.com/" }, /takes only language, code and files/],
    [{ code: "print(1)", language: "python" }, /language must be one of js, bash/],
    [{ code: "cat x", language: "bash", files: { "../x": "a" } }, /invalid file path/],
    [{ code: "return 1;", timeoutMs: 60_000 }, /takes only language, code and files/],
    [null, /object/],
  ])("rejects %j", (input, message) => {
    expect(() => parseRunCode(input)).toThrow(message);
  });

  it("bounds a run's result from the extension", () => {
    expect(parseRunCodeResult({ ok: true, value: "x".repeat(30_000), logs: ["a"], truncated: false }))
      .toEqual({ ok: true, value: "x".repeat(RUN_CODE_LIMITS.maxOutputChars), logs: ["a"], truncated: true });
    expect(parseRunCodeResult({ ok: false, error: { code: "EXIT_STATUS", message: "exit status 1" }, stdout: "o", stderr: "e", exitCode: 1, logs: [], truncated: false }))
      .toEqual({ ok: false, error: { code: "EXIT_STATUS", message: "exit status 1" }, stdout: "o", stderr: "e", exitCode: 1, logs: [], truncated: false });
    expect(parseRunCodeResult({ ok: true, value: "1", logs: Array.from({ length: 80 }, () => "l".repeat(900)), truncated: false }).logs)
      .toHaveLength(41);
    for (const bad of [null, { ok: "yes", logs: [] }, { ok: true, value: 1, logs: [] }, { ok: false, logs: [], truncated: false },
      { ok: false, error: { code: "lower case", message: "" }, logs: [], truncated: false }, { ok: true, value: "1", logs: "a", truncated: false }]) {
      expect(() => parseRunCodeResult(bad)).toThrow("INVALID_RESULT");
    }
  });
});

describe("confirmation rule", () => {
  const click = { action: "click" as const, tabId: 1, ref: "e1" };
  it.each([
    ["Send", "button", false], ["Post", "button", false], ["Buy now", "button", false], ["Place order", "button", false],
    ["Delete account", "menuitem", false], ["提交", "button", false], ["发送", "link", false], ["Continue", "button", true],
    ["Place order", "clickable", false],
  ])("asks before clicking %s (%s, inForm=%s)", (name, role, inForm) => {
    expect(confirmationReason(click, { role, name, inForm }, null)).toMatch(new RegExp(name));
  });

  it.each([["Next page", "link"], ["Show more", "button"], ["Facebook", "link"], ["Search", "button"], ["Select a country", "clickable"]])("does not ask before clicking %s", (name, role) => {
    expect(confirmationReason(click, { role, name, inForm: name === "Search" }, null)).toBeNull();
  });

  it("asks before submitting typed text except in a search field", () => {
    const type = { action: "type" as const, tabId: 1, ref: "e1", text: "hi", submit: true };
    expect(confirmationReason(type, { role: "textbox", name: "Message" }, null)).toMatch(/press Enter/);
    expect(confirmationReason(type, { role: "searchbox", name: "q" }, null)).toBeNull();
    expect(confirmationReason({ ...type, submit: false }, { role: "textbox", name: "Message" }, null)).toBeNull();
  });

  it("asks before Enter in a text field, except a search field", () => {
    const press = { action: "press" as const, tabId: 1, key: "Enter" as const };
    expect(confirmationReason(press, null, { role: "textbox", name: "Reply" })).toMatch(/press Enter in textbox/);
    expect(confirmationReason(press, null, { role: "textbox", name: "Search products" })).toBeNull();
    expect(confirmationReason(press, null, { role: "searchbox", name: "q" })).toBeNull();
    expect(confirmationReason({ ...press, key: "Space" }, null, { role: "textbox", name: "Reply" })).toBeNull();
    expect(confirmationReason({ ...press, key: "Tab" }, null, { role: "textbox", name: "Reply" })).toBeNull();
  });

  it("judges Enter or Space on a focused control like a click on it", () => {
    const press = { action: "press" as const, tabId: 1, key: "Enter" as const };
    // Not any button: only one a click would ask about.
    expect(confirmationReason(press, null, { role: "button", name: "Open the next page", inForm: false })).toBeNull();
    expect(confirmationReason(press, null, { role: "link", name: "Docs" })).toBeNull();
    expect(confirmationReason(press, null, { role: "clickable", name: "Select a country" })).toBeNull();
    expect(confirmationReason(press, null, null)).toBeNull();
    expect(confirmationReason(press, null, { role: "button", name: "Continue", inForm: true })).toMatch(/press Enter on button "Continue"/);
    expect(confirmationReason(press, null, { role: "button", name: "Send", inForm: false })).toMatch(/press Enter on button/);
    expect(confirmationReason({ ...press, key: "Space" }, null, { role: "link", name: "Delete account" })).toMatch(/press Space on link/);
    expect(confirmationReason(press, null, { role: "iframe", name: "" })).toMatch(/cannot be inspected/);
  });

  it("never asks for reads or navigation", () => {
    for (const action of ["snapshot", "read_text", "screenshot", "scroll", "tabs"] as const) {
      expect(confirmationReason({ action, tabId: 1, direction: "down" }, { role: "button", name: "Send" }, null)).toBeNull();
    }
  });
});

describe("Routine contract", () => {
  const body = { title: " Morning tabs ", routinePrompt: "Summarize my open tabs.", enabled: true, idempotencyKey: "routine-save:1234",
    schedule: { days: [1, 2, 3, 4, 5], localTime: "09:00", timezone: "UTC", jitterMinutes: 15 } };

  it("accepts a save body with or without permissions, the schedule without its own on/off or next run", () => {
    expect(parseRoutineSave(body)).toEqual({ ...body, title: "Morning tabs" });
    expect(parseRoutineSave({ ...body, permissions: { update: false, write: true } }).permissions).toEqual({ update: false, write: true });
    // The editor sends the Routine it saves; the path names it, so the body's copy is ignored.
    expect(parseRoutineSave({ ...body, threadId: "routine_1" })).not.toHaveProperty("threadId");
  });

  it.each([
    [{ ...body, title: "" }, /title/],
    [{ ...body, enabled: "yes" }, /enabled/],
    [{ ...body, idempotencyKey: "short" }, /idempotencyKey/],
    [{ ...body, model: "cheap/model" }, /unknown field/],
    [{ ...body, routinePrompt: " " }, /ROUTINE_PROMPT_INVALID/],
    [{ ...body, schedule: { ...body.schedule, days: [] } }, /ROUTINE_SCHEDULE_INVALID/],
    [{ ...body, schedule: { ...body.schedule, nextAt: "2026-01-01T00:00:00Z" } }, /nextAt/],
    [{ ...body, permissions: { update: true } }, /AGENT_THREAD_PERMISSIONS_INVALID/],
  ])("refuses %j", (input, message) => {
    expect(() => parseRoutineSave(input)).toThrow(message);
  });

  it("reads a run request's key and optional permissions", () => {
    expect(parseRoutineRun({ idempotencyKey: "routine-run:abcd" })).toEqual({ idempotencyKey: "routine-run:abcd" });
    expect(parseRoutineRun({ idempotencyKey: "routine-run:abcd", permissions: { update: false, write: false } }).permissions).toEqual({ update: false, write: false });
    expect(() => parseRoutineRun({})).toThrow(/INVALID_ROUTINE/);
  });

  it("names the browser actions a read-only run may not make", () => {
    expect([...ACTING_ACTIONS].sort()).toEqual(["click", "press", "select", "type"]);
    expect(ACTING_ACTIONS).not.toContain("navigate");
  });
});

describe("a message's images", () => {
  // Base64 that starts like a PNG or a JPEG (the Worker checks the signature, not the whole file).
  const png = (length = 16) => `iVBORw0KGgo${"A".repeat(length - 11)}`;
  const jpeg = (length = 16) => `/9j/${"A".repeat(length - 4)}`;

  it("accepts up to four PNG or JPEG images; none when absent", () => {
    expect(parseTurnImages(undefined)).toEqual([]);
    expect(parseTurnImages(null)).toEqual([]);
    const images = [{ mimeType: "image/png", data: png() }, { mimeType: "image/jpeg", data: jpeg(), name: "dropped.jpg" }];
    expect(parseTurnImages(images)).toEqual([{ mimeType: "image/png", data: png() }, { mimeType: "image/jpeg", data: jpeg() }]);
  });

  it.each([
    ["not an array", { mimeType: "image/png", data: "iVBORw0KGgoA" }, /must be an array/],
    ["a fifth image", Array.from({ length: MAX_TURN_IMAGES + 1 }, () => ({ mimeType: "image/png", data: png() })), /at most 4 images/],
    ["a GIF", [{ mimeType: "image/gif", data: "R0lGODlhAQAB" }], /mimeType must be one of/],
    ["a WebP (the panel re-encodes it)", [{ mimeType: "image/webp", data: "UklGRgAAAAAA" }], /mimeType must be one of/],
    ["bytes of another type", [{ mimeType: "image/png", data: jpeg() }], /not a base64 image\/png/],
    ["not base64", [{ mimeType: "image/jpeg", data: "/9j/<script>" }], /not a base64 image\/jpeg/],
    ["one image over the limit", [{ mimeType: "image/png", data: png(MAX_TURN_IMAGE_BASE64 + 4) }], /at most 700000 characters/],
    ["all images over the limit", Array.from({ length: 3 }, () => ({ mimeType: "image/jpeg", data: jpeg(MAX_TURN_IMAGE_BASE64) })), /total at most/],
  ])("refuses %s", (_name, input, message) => {
    expect(() => parseTurnImages(input)).toThrow("INVALID_IMAGES");
    expect(() => parseTurnImages(input)).toThrow(message);
  });
});
