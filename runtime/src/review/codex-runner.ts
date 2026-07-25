import {
  runIndependentReview,
  type ReviewRunnerOptions
} from "./runner.js";

export function runCodexReview(options: ReviewRunnerOptions) {
  return runIndependentReview(options);
}
