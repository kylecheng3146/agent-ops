import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { setTimeout } from "node:timers/promises";

describe("outer", { concurrency: true }, () => {
  describe("left", { concurrency: true }, () => {
    it("same", async () => { await setTimeout(15); assert.equal(1, 1); });
    it("same", () => assert.equal(2, 2));
    shared();
  });
  describe("right", () => {
    it("same", () => assert.equal(3, 3));
    shared();
  });
});

function shared() {
  it("shared", () => assert.equal(4, 4));
}
