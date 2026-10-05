import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it, test } from "node:test";
import { setTimeout } from "node:timers/promises";

describe("before assertion", () => {
  beforeEach(() => assert.fail("fixture assertion"));
  it("body", () => assert.equal(1, 1));
});
describe("after assertion", () => {
  afterEach(() => assert.fail("teardown assertion"));
  it("body", () => assert.equal(1, 1));
});
test("timeout", { timeout: 10 }, () => setTimeout(40));
test("skipped", { skip: "" }, () => assert.fail("must not run"));
test("todo", { todo: "" }, () => assert.fail("expected failure"));
