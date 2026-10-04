import assert from "node:assert/strict";
import test from "node:test";

test("stream pass", () => assert.equal(2 + 2, 4));
test("stream assertion", () => assert.equal(2 + 2, 5));
