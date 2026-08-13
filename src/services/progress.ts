// Tracks progress of the in-flight /api/wishlist request so the UI can poll
// it for a status bar instead of showing an indefinite "Refreshing…" spinner.
// This app is single-user/single-request in practice, so one shared module-level
// state is enough — no need to key it per request.

export interface ProgressState {
  active: boolean;
  phase: string;
  total: number;
  completed: number;
  startedAt: number | null;
}

let state: ProgressState = {
  active: false,
  phase: "idle",
  total: 0,
  completed: 0,
  startedAt: null,
};

export function getProgress(): ProgressState {
  return state;
}

export function startProgress(phase: string): void {
  state = { active: true, phase, total: 0, completed: 0, startedAt: Date.now() };
}

export function setProgressPhase(phase: string, total = 0): void {
  state = { ...state, phase, total, completed: 0 };
}

export function incrementProgress(by = 1): void {
  state = { ...state, completed: state.completed + by };
}

export function finishProgress(): void {
  state = { ...state, active: false, phase: "done" };
}
