import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ACTIVE_POLL_MS, IDLE_POLL_MS, pollDelay, poller } from "../src/ext/poll-schedule.ts";

describe("side panel poll schedule", () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  it("polls every second while a turn is active, once a minute idle, and not at all idle and hidden", () => {
    expect(pollDelay(true, true)).toBe(ACTIVE_POLL_MS);
    expect(pollDelay(true, false)).toBe(ACTIVE_POLL_MS);
    expect(pollDelay(false, true)).toBe(IDLE_POLL_MS);
    expect(pollDelay(false, false)).toBeNull();
    // An idle, visible panel stays under 3,000 Durable Object requests a day (two per listTurns).
    expect(2 * 86_400_000 / IDLE_POLL_MS).toBeLessThan(3_000);
  });

  it("refreshes fast while active, backs off when idle, and a send or focus refreshes at once", async () => {
    let active = true;
    let visible = true;
    let refreshes = 0;
    const poll = poller(async () => { refreshes++; return active; }, () => visible);
    poll.wake();
    await vi.advanceTimersByTimeAsync(0);
    expect(refreshes).toBe(1);
    await vi.advanceTimersByTimeAsync(3 * ACTIVE_POLL_MS);
    expect(refreshes).toBe(4);

    active = false; // the turn ended: the next refresh sees it and backs off
    await vi.advanceTimersByTimeAsync(ACTIVE_POLL_MS);
    expect(refreshes).toBe(5);
    await vi.advanceTimersByTimeAsync(IDLE_POLL_MS - 1);
    expect(refreshes).toBe(5);
    await vi.advanceTimersByTimeAsync(1);
    expect(refreshes).toBe(6);

    poll.wake(); // the user sends a message or focuses the panel
    await vi.advanceTimersByTimeAsync(0);
    expect(refreshes).toBe(7);
    // The wake replaced the idle timer rather than adding a second one.
    await vi.advanceTimersByTimeAsync(IDLE_POLL_MS);
    expect(refreshes).toBe(8);

    visible = false; // hidden and idle: nothing until the panel is shown again
    await vi.advanceTimersByTimeAsync(IDLE_POLL_MS);
    expect(refreshes).toBe(9);
    await vi.advanceTimersByTimeAsync(10 * IDLE_POLL_MS);
    expect(refreshes).toBe(9);
    visible = true;
    poll.wake();
    await vi.advanceTimersByTimeAsync(0);
    expect(refreshes).toBe(10);
  });

  it("a wake during a refresh runs one more right after it, so a just-sent message is seen", async () => {
    let refreshes = 0;
    let release: (() => void) | undefined;
    const poll = poller(() => { refreshes++; return new Promise<boolean>(resolve => { release = () => resolve(false); }); }, () => true);
    poll.wake();
    poll.wake();
    poll.wake();
    expect(refreshes).toBe(1);
    release!();
    await vi.advanceTimersByTimeAsync(0);
    expect(refreshes).toBe(2);
    release!();
    await vi.advanceTimersByTimeAsync(0);
    expect(refreshes).toBe(2);
  });

  it("a stopped schedule refreshes no more, even when woken", async () => {
    let refreshes = 0;
    const poll = poller(async () => { refreshes++; return true; }, () => true);
    poll.wake();
    await vi.advanceTimersByTimeAsync(0);
    poll.stop();
    poll.wake();
    await vi.advanceTimersByTimeAsync(10 * ACTIVE_POLL_MS);
    expect(refreshes).toBe(1);
  });
});
