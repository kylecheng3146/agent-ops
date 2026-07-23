import assert from "node:assert/strict";
import test from "node:test";

import { redactSecrets } from "../../runtime/src/security/redact.js";

test("redacts credential-shaped synthetic values", () => {
  const pat = ["gh", "p_", "a".repeat(30)].join("");
  const apiToken = ["sk", "-", "b".repeat(30)].join("");
  const queryValue = "synthetic-query-value";
  const headerValue = "synthetic-header-value";
  const environmentValue = "synthetic-environment-value";
  const privateMaterial = "SYNTHETIC_PRIVATE_MATERIAL";
  const privateHeader = ["-----BEGIN ", "PRIVATE KEY-----"].join("");
  const privateFooter = ["-----END ", "PRIVATE KEY-----"].join("");
  const source = [
    ["token", "=", environmentValue].join(""),
    ["Authorization", ": Bearer ", headerValue].join(""),
    [
      "https://example.com/path?",
      "token",
      "=",
      queryValue,
      "&safe=value"
    ].join(""),
    `github=${pat}`,
    `provider=${apiToken}`,
    privateHeader,
    privateMaterial,
    privateFooter
  ].join("\n");

  const redacted = redactSecrets(source);

  for (const secret of [
    pat,
    apiToken,
    queryValue,
    headerValue,
    environmentValue,
    privateMaterial
  ]) {
    assert.doesNotMatch(redacted, new RegExp(secret));
  }
  assert.match(redacted, /\[REDACTED/);
  assert.match(redacted, /safe=value/);
});

test("preserves benign lookalikes", () => {
  const benign = [
    "token count: 42",
    "Authorization policy is documented.",
    ["sk", "-short"].join(""),
    ["https://example.com/?", "token", "="].join(""),
    ["-----BEGIN ", "PUBLIC KEY-----"].join("")
  ].join("\n");

  assert.equal(redactSecrets(benign), benign);
});
