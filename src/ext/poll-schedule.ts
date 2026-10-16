// The side panel's request schedule: how often it asks the Worker for its turns. While a turn is
// not terminal it polls every second (and the work loop long-polls claims); idle, it polls once a
// minute while visible and not at all while hidden, and never claims, so an idle panel costs the
// account's Durable Object at most 1,440 listTurns requests a day (2,880 Durable Object requests:
// each HTTP request is an authenticate and a listTurns call). A send, focus or the panel being
// shown again refreshes at once.

export const ACTIVE_POLL_MS = 1_000;
export const IDLE_POLL_MS = 60_000;

/** The wait before the next refresh; null: none until something wakes the poller. */
export function pollDelay(active: boolean, visible: boolean): number | null {
  if (active) return ACTIVE_POLL_MS;
  return visible ? IDLE_POLL_MS : null;
}

export interface Timers { set(run: () => void, ms: number): unknown; clear(handle: unknown): void; }
const realTimers: Timers = { set: (run, ms) => setTimeout(run, ms), clear: handle => clearTimeout(handle as ReturnType<typeof setTimeout>) };

/**
 * Runs `refresh` (which reports whether any turn is not terminal) on the schedule above. `wake`
 * refreshes now; a wake during a refresh runs one more right after it, so a just-sent message is seen.
 * `stop` ends the schedule (the chat left the thread).
 */
export function poller(refresh: () => Promise<boolean>, visible: () => boolean, timers: Timers = realTimers): { wake(): void; stop(): void } {
  let timer: unknown;
  let running = false;
  let again = false;
  let stopped = false;
  const run = async (): Promise<void> => {
    if (stopped) return;
    if (running) { again = true; return; }
    timers.clear(timer);
    running = true;
    let active = false;
    try { active = await refresh(); } catch { /* refresh reports its own errors */ } finally { running = false; }
    if (again) { again = false; return run(); }
    if (stopped) return;
    const delay = pollDelay(active, visible());
    if (delay !== null) timer = timers.set(() => void run(), delay);
  };
  return { wake: () => void run(), stop: () => { stopped = true; timers.clear(timer); } };
}
