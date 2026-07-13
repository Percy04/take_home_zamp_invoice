import { useSyncExternalStore } from "react";
import type { Run } from "./types";

type State = { runs: Run[] };
let state: State = { runs: [] };
const listeners = new Set<() => void>();

function setState(next: State) {
  state = next;
  listeners.forEach((listener) => listener());
}

export function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function getState() {
  return state;
}

export function useStore<T>(selector: (state: State) => T): T {
  return useSyncExternalStore(
    subscribe,
    () => selector(state),
    () => selector({ runs: [] }),
  );
}

export function replaceRuns(runs: Run[]) {
  setState({ runs });
}

export function upsertRun(run: Run) {
  const existing = state.runs.some((item) => item.runId === run.runId);
  setState({
    runs: existing
      ? state.runs.map((item) => (item.runId === run.runId ? run : item))
      : [run, ...state.runs],
  });
}

export function clearRuns() {
  setState({ runs: [] });
}
