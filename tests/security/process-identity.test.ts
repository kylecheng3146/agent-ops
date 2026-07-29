import assert from "node:assert/strict";
import test from "node:test";

import { reuseCachedProcessIdentity } from "../../runtime/src/security/permissions.js";

const SELF = 4242;
const NOW = 1_000_000;

test("a successful self identity never expires", () => {
  assert.equal(
    reuseCachedProcessIdentity(
      { checkedAt: NOW - 60_000, identity: "windows:638000000000000000" },
      SELF,
      SELF,
      NOW
    ),
    true
  );
});

test("a fallback self identity stays retryable", () => {
  assert.equal(
    reuseCachedProcessIdentity(
      { checkedAt: NOW - 60_000, identity: "runtime:token" },
      SELF,
      SELF,
      NOW
    ),
    false
  );
  assert.equal(
    reuseCachedProcessIdentity(
      { checkedAt: NOW - 10, identity: "runtime:token" },
      SELF,
      SELF,
      NOW
    ),
    true
  );
});

test("foreign process identities keep the short TTL", () => {
  assert.equal(
    reuseCachedProcessIdentity(
      { checkedAt: NOW - 10, identity: "windows:1" },
      99,
      SELF,
      NOW
    ),
    true
  );
  assert.equal(
    reuseCachedProcessIdentity(
      { checkedAt: NOW - 60_000, identity: "windows:1" },
      99,
      SELF,
      NOW
    ),
    false
  );
});

test("an absent entry is never reused", () => {
  assert.equal(
    reuseCachedProcessIdentity(undefined, SELF, SELF, NOW),
    false
  );
});
