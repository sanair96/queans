export interface HumanReviewWaitState {
  reviewStillOpen: boolean;
  previousSignalCount: number;
  currentSignalCount: number;
}

export const humanReviewRecheckInterval = "1 minute";

export function shouldWaitForHumanReviewSignal(state: HumanReviewWaitState) {
  return state.reviewStillOpen && state.currentSignalCount <= state.previousSignalCount;
}
