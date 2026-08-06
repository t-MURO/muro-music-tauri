import type { TransitionPlan } from "./plan";

export type TransitionSeekPhase = "before" | "inside" | "after";

export const getTransitionSeekPhase = (
  plan: TransitionPlan,
  outgoingPositionSec: number,
): TransitionSeekPhase => {
  if (outgoingPositionSec < plan.startAtSec) return "before";
  if (outgoingPositionSec >= plan.startAtSec + plan.durationSec) return "after";
  return "inside";
};
