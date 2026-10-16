// pi-do's ChatClient for agent-core's chat UI: its Worker API over fetch (api.ts), changes found by
// polling (poll-schedule.ts: every second while a turn is active, once a minute idle), and the
// selected thread kept in the extension's storage. It also tells the panel whether a turn is active,
// which starts the browser work loop.
import type { ChatClient, ChatTurn, ThreadSummary } from "agent-core/ui";
import { TERMINAL, type TabContext, type TurnImage, type TurnView } from "../shared/protocol.ts";
import { ApiError, cancelTurn, deleteThread, fetchTurnImage, listThreads, listTurns, retryTurn, saveSettings, sendMessage, type Settings } from "./api.ts";
import { poller } from "./poll-schedule.ts";

export interface PanelLink {
  /** The connected Worker and account, read at each call; null when not connected. */
  settings(): Settings | null;
  /** The tab the message is about, sent with it. */
  tabContext(): Promise<TabContext | null>;
  /** A response showed whether a turn is active (the work loop claims browser calls only then). */
  onActivity(active: boolean): void;
  /** The Worker no longer accepts the account's token. */
  onUnauthorized(): void;
}

const active = (turns: TurnView[]) => turns.some(turn => !TERMINAL.includes(turn.status));
// The Worker accepts only these characters in an idempotency key.
const workerKey = (key: string) => key.replace(/[^A-Za-z0-9_-]/g, "_").slice(-128);

export function piDoChatClient(link: PanelLink): ChatClient {
  const connected = (): Settings => {
    const settings = link.settings();
    if (!settings) throw new ApiError("NOT_CONNECTED", 0);
    return settings;
  };
  // A 401 disconnects the panel; every failure reaches the chat as its code.
  const guarded = async <T>(request: () => Promise<T>): Promise<T> => {
    try { return await request(); }
    catch (error) {
      if (error instanceof ApiError && error.status === 401) link.onUnauthorized();
      throw new Error(error instanceof ApiError ? error.code : String((error as Error)?.message ?? error));
    }
  };
  // A message's images are loaded once per panel (object URLs); one that fails to load is shown by its label.
  const imageUrls = new Map<string, Promise<string | undefined>>();
  const imageUrl = (turnId: string, index: number) => {
    const key = `${turnId}/${index}`;
    if (!imageUrls.has(key)) imageUrls.set(key, fetchTurnImage(connected(), turnId, index).then(blob => URL.createObjectURL(blob), () => undefined));
    return imageUrls.get(key)!;
  };
  const withImages = async (view: TurnView): Promise<ChatTurn> => (view.images?.length
    ? { ...view, images: await Promise.all(view.images.map(async (image, index) => ({ mimeType: image.mimeType, src: await imageUrl(view.turnId, index) }))) }
    : view) as unknown as ChatTurn;
  let lastActive = false;
  let wakePoll = () => {};
  // A turn just started or retried: poll at the active pace from now, and start the work loop.
  const turn = (view: TurnView) => {
    if (active([view])) { lastActive = true; link.onActivity(true); wakePoll(); }
    return view as unknown as ChatTurn;
  };
  return {
    listThreads: ({ limit }) => guarded(async () => (await listThreads(connected(), limit)).threads as unknown as ThreadSummary[]),
    // A thread exists on the Worker once it has a message; until then it is only this id.
    createThread: async () => {
      const now = new Date().toISOString();
      return { threadId: `t_${crypto.randomUUID().replaceAll("-", "").slice(0, 24)}`, title: null, createdAt: now, updatedAt: now, latestTurnStatus: null };
    },
    // Deleting archives the thread on the Worker; a thread never sent a message exists only here.
    deleteThread: (threadId) => guarded(async () => {
      try { return await deleteThread(connected(), threadId); }
      catch (error) { if (!(error instanceof ApiError && error.code === "AGENT_THREAD_NOT_FOUND")) throw error; return null; }
    }),
    listTurns: (threadId, page) => guarded(async () => {
      const { turns, nextBefore } = await listTurns(connected(), threadId, page);
      if (!page.before) { lastActive = active(turns); link.onActivity(lastActive); }
      return { items: await Promise.all(turns.map(withImages)), nextBefore };
    }),
    submitTurn: ({ threadId, text, idempotencyKey, images }) => guarded(async () =>
      turn((await sendMessage(connected(), { threadId, text, context: await link.tabContext(), idempotencyKey: workerKey(idempotencyKey),
        ...(images?.length ? { images: images as TurnImage[] } : {}) })).turn)),
    stopTurn: (turnId) => guarded(async () => (await cancelTurn(connected(), turnId)).turn as unknown as ChatTurn),
    retryTurn: (turnId, idempotencyKey) => guarded(async () => turn((await retryTurn(connected(), turnId, idempotencyKey)).turn)),
    subscribe(refresh) {
      const poll = poller(async () => { await refresh(); return lastActive; }, () => document.visibilityState === "visible");
      const wake = () => poll.wake();
      wakePoll = wake;
      const visible = () => { if (document.visibilityState === "visible") wake(); };
      window.addEventListener("focus", wake);
      document.addEventListener("visibilitychange", visible);
      wake();
      return () => {
        poll.stop();
        wakePoll = () => {};
        window.removeEventListener("focus", wake);
        document.removeEventListener("visibilitychange", visible);
      };
    },
    loadSelectedThread: async () => link.settings()?.threadId ?? null,
    saveSelectedThread: (threadId) => saveSettings({ threadId: threadId ?? undefined }),
  };
}
