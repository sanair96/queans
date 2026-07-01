export interface HumanReviewWaitState {
  reviewStillOpen: boolean;
  previousSignalCount: number;
  currentSignalCount: number;
}

export function shouldWaitForHumanReviewSignal(state: HumanReviewWaitState) {
  return state.reviewStillOpen && state.currentSignalCount <= state.previousSignalCount;
}
