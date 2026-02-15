import type { DashboardEvent, DashboardSnapshot } from "./types";

export type UiState = {
  snapshot: DashboardSnapshot | null;
  liveEvents: DashboardEvent[];
};

export const initialUiState: UiState = {
  snapshot: null,
  liveEvents: []
};

export function applyEvent(state: UiState, evt: DashboardEvent): UiState {
  const nextSnapshot = evt.snapshot ?? state.snapshot;
  const liveEvents = [evt, ...state.liveEvents].slice(0, 200);
  return { snapshot: nextSnapshot, liveEvents };
}
