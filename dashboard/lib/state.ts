import type { DashboardEvent, DashboardSnapshot } from "./types";

export type UiState = {
  snapshot: DashboardSnapshot | null;
  liveEvents: DashboardEvent[];
};

export const initialUiState: UiState = {
  snapshot: null,
  liveEvents: []
};

const noisyEvents = new Set([
  "mixer.meters",
  "state.updated",
  "publisher.ffmpeg"
]);

export function applyEvent(state: UiState, evt: DashboardEvent): UiState {
  const nextSnapshot = evt.snapshot ?? state.snapshot;
  if (!evt.snapshot && noisyEvents.has(evt.event)) {
    if (nextSnapshot === state.snapshot) {
      return state;
    }
    return { ...state, snapshot: nextSnapshot };
  }
  const liveEvents = [evt, ...state.liveEvents].slice(0, 200);
  return { snapshot: nextSnapshot, liveEvents };
}
