// pi-do's RoutineClient for agent-core's Routine view: its Worker's Routine endpoints over fetch
// (api.ts), read again every ten seconds while the view is shown and the panel visible. It also
// tells the panel whether a Routine is on a schedule, so the work loop looks for a run's browser
// calls while the panel is open.
import type { RoutineClient } from "agent-core/ui/routines";
import type { RoutineListView } from "../shared/protocol.ts";
import { ApiError, deleteRoutine, deleteThread, getRoutine, listRoutines, runRoutine, saveRoutine, type Settings } from "./api.ts";

export const ROUTINE_POLL_MS = 10_000;

export interface RoutineLink {
  settings(): Settings | null;
  /** The newest list read: whether any Routine is on a schedule. */
  onList(list: RoutineListView): void;
  onUnauthorized(): void;
}

export function piDoRoutineClient(link: RoutineLink): RoutineClient {
  // A 401 disconnects the panel; every failure reaches the view as its code.
  const guarded = async <T>(request: (settings: Settings) => Promise<T>): Promise<T> => {
    const settings = link.settings();
    if (!settings) throw new Error("NOT_CONNECTED");
    try { return await request(settings); }
    catch (error) {
      if (error instanceof ApiError && error.status === 401) link.onUnauthorized();
      throw new Error(error instanceof ApiError ? error.code : String((error as Error)?.message ?? error));
    }
  };
  return {
    list: () => guarded(async settings => { const list = await listRoutines(settings); link.onList(list); return list; }),
    get: (_accountId, threadId) => guarded(settings => getRoutine(settings, threadId)),
    // The path names the Routine; its definition is the rest of the body.
    save: (_accountId, { threadId, ...request }) => guarded(settings => saveRoutine(settings, threadId, request)),
    remove: (_accountId, threadId) => guarded(settings => deleteRoutine(settings, threadId)),
    removeRun: (_accountId, threadId) => guarded(settings => deleteThread(settings, threadId)),
    run: (_accountId, { threadId, ...input }) => guarded(settings => runRoutine(settings, threadId, input)),
    subscribe(_accountId, onChange) {
      void onChange();
      const timer = setInterval(() => { if (document.visibilityState === "visible") void onChange(); }, ROUTINE_POLL_MS);
      return () => clearInterval(timer);
    },
  };
}
