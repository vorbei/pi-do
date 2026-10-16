import { afterEach, describe, expect, it, vi } from "vitest";
import { piDoChatClient, type PanelLink } from "../src/ext/chat-client.ts";

const SETTINGS = { workerUrl: "https://worker.example", token: "acct_0123.secret", threadId: "t_saved", memoryUpdate: false };
const CONTEXT = { tabId: 7, url: "https://example.com/", title: "Example" };

function setup(responses: Record<string, { status?: number; body: unknown }>) {
  const requests: { url: string; method: string; body: any; authorization: string | null }[] = [];
  vi.stubGlobal("fetch", async (url: string, init: RequestInit) => {
    requests.push({ url, method: init.method ?? "GET", body: init.body ? JSON.parse(String(init.body)) : null, authorization: new Headers(init.headers).get("Authorization") });
    const path = new URL(url).pathname;
    const response = responses[path] ?? { status: 404, body: { error: "NOT_FOUND" } };
    return new Response(JSON.stringify(response.body), { status: response.status ?? 200 });
  });
  const activity: boolean[] = [];
  let unauthorized = 0;
  const link: PanelLink = { settings: () => SETTINGS, tabContext: async () => CONTEXT, onActivity: active => activity.push(active), onUnauthorized: () => { unauthorized++; } };
  return { client: piDoChatClient(link), requests, activity, unauthorized: () => unauthorized };
}

const turn = (status: string) => ({ turnId: "turn_1", status, input: "hi", progress: { label: "", items: [] } });

describe("the panel's chat client over the Worker API", () => {
  afterEach(() => { vi.unstubAllGlobals(); });

  it("pages a thread's turns as the chat's items and reports whether a turn is active", async () => {
    const { client, requests, activity } = setup({ "/api/threads/t_1/turns": { body: { turns: [turn("running")], nextBefore: "turn_0" } } });
    expect(await client.listTurns("t_1", { limit: 50 })).toMatchObject({ items: [{ turnId: "turn_1" }], nextBefore: "turn_0" });
    await client.listTurns("t_1", { limit: 50, before: "turn_0" });
    expect(requests.map(request => request.url)).toEqual([
      "https://worker.example/api/threads/t_1/turns?limit=50", "https://worker.example/api/threads/t_1/turns?limit=50&before=turn_0"]);
    expect(requests[0].authorization).toBe("Bearer acct_0123.secret");
    // An older page says nothing about whether work is running now.
    expect(activity).toEqual([true]);
  });

  it("sends a message with the tab it is about, the memory permission and a key the Worker accepts", async () => {
    const { client, requests, activity } = setup({ "/api/turns": { body: { turn: turn("queued") } } });
    await client.submitTurn({ threadId: "t_1", text: "Read this", whileRunning: "steer", idempotencyKey: "chat:t_1:6f1c-11aa" });
    expect(requests[0].body).toEqual({ threadId: "t_1", text: "Read this", context: CONTEXT, idempotencyKey: "chat_t_1_6f1c-11aa", memory: { update: false } });
    expect(activity).toEqual([true]);
  });

  it("sends a message's images, and loads a listed turn's images once each as URLs the chat shows", async () => {
    const view = { ...turn("completed"), images: [{ mimeType: "image/png" }, { mimeType: "image/jpeg" }] };
    const { client, requests } = setup({ "/api/turns": { body: { turn: view } }, "/api/threads/t_1/turns": { body: { turns: [view], nextBefore: null } },
      "/api/turns/turn_1/images/0": { body: "png bytes" } });
    const images = [{ mimeType: "image/png", data: "iVBORw0KGgoAAAANSUhEUg==" }];
    await client.submitTurn({ threadId: "t_1", text: "", whileRunning: "steer", idempotencyKey: "chat:t_1:1", images });
    expect(requests[0].body).toMatchObject({ text: "", images });
    const [listed] = (await client.listTurns("t_1", { limit: 50 })).items;
    // The second image is missing on the Worker (404): it is shown by its label, not dropped.
    expect(listed.images).toEqual([{ mimeType: "image/png", src: expect.stringMatching(/^blob:/) }, { mimeType: "image/jpeg", src: undefined }]);
    await client.listTurns("t_1", { limit: 50 });
    expect(requests.filter(request => request.url.includes("/images/")).map(request => [request.url, request.authorization])).toEqual([
      ["https://worker.example/api/turns/turn_1/images/0", "Bearer acct_0123.secret"], ["https://worker.example/api/turns/turn_1/images/1", "Bearer acct_0123.secret"]]);
  });

  it("stops and retries turns; a refused token disconnects the panel and the error is the Worker's code", async () => {
    const { client, requests, unauthorized } = setup({
      "/api/turns/turn_1/cancel": { body: { turn: turn("cancelled") } },
      "/api/turns/turn_1/retry": { body: { turn: turn("queued") } },
      "/api/threads": { status: 401, body: { error: "UNAUTHORIZED" } },
    });
    expect(await client.stopTurn("turn_1")).toMatchObject({ status: "cancelled" });
    expect(await client.retryTurn("turn_1", "retry:turn_1:abc")).toMatchObject({ status: "queued" });
    expect(requests[1].body).toEqual({ idempotencyKey: "retry:turn_1:abc" });
    await expect(client.listThreads({ limit: 20 })).rejects.toThrow("UNAUTHORIZED");
    expect(unauthorized()).toBe(1);
  });

  it("deletes a thread on the Worker; one that never had a message is already gone", async () => {
    const { client, requests } = setup({ "/api/threads/t_1": { body: { thread: { threadId: "t_1", status: "archived" } } },
      "/api/threads/t_busy": { status: 400, body: { error: "AGENT_THREAD_BUSY" } },
      "/api/threads/t_local": { status: 400, body: { error: "AGENT_THREAD_NOT_FOUND" } } });
    expect(await client.deleteThread!("t_1")).toMatchObject({ thread: { status: "archived" } });
    expect(requests[0]).toMatchObject({ url: "https://worker.example/api/threads/t_1", method: "DELETE" });
    await expect(client.deleteThread!("t_busy")).rejects.toThrow("AGENT_THREAD_BUSY");
    expect(await client.deleteThread!("t_local")).toBeNull();
  });

  it("a new thread is only an id until its first message; the selected thread is the stored one", async () => {
    const { client, requests } = setup({});
    const thread = await client.createThread({ idempotencyKey: "create-chat:acct:1" });
    expect(thread.threadId).toMatch(/^t_[a-f0-9]{24}$/);
    expect(requests).toEqual([]);
    expect(await client.loadSelectedThread!()).toBe("t_saved");
  });
});
