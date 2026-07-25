import {
  runIndependentReview,
  type ReviewRunnerOptions
} from "./runner.js";

export function runClaudeReview(options: ReviewRunnerOptions) {
  return runIndependentReview(options);
}
