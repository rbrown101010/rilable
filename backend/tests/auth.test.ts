import assert from "node:assert/strict";
import test from "node:test";

import {
  ACCESS_TOKEN_ENV,
  AI_PROXY_PUBLIC_ENV,
  configuredAccessToken,
  httpAccessToken,
  isAccessTokenValid,
  isPublicAiProxyAllowed,
  requireAccessToken,
  requireAiProxyAccess,
} from "../convex/auth";

function withEnv(env: Record<string, string | undefined>, fn: () => void): void {
  const previous = new Map<string, string | undefined>();
  for (const key of Object.keys(env)) {
    previous.set(key, process.env[key]);
    const value = env[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  try {
    fn();
  } finally {
    for (const [key, value] of previous.entries()) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

test("access token is optional for local no-key experiments", () => {
  withEnv({ [ACCESS_TOKEN_ENV]: undefined }, () => {
    assert.equal(configuredAccessToken(), null);
    assert.equal(isAccessTokenValid(undefined), true);
    assert.doesNotThrow(() => requireAccessToken(undefined));
  });
});

test("configured access token rejects missing or wrong client tokens", () => {
  withEnv({ [ACCESS_TOKEN_ENV]: "secret" }, () => {
    assert.equal(configuredAccessToken(), "secret");
    assert.equal(isAccessTokenValid(undefined), false);
    assert.equal(isAccessTokenValid("wrong"), false);
    assert.equal(isAccessTokenValid("secret"), true);
    assert.throws(() => requireAccessToken(undefined), /Unauthorized/);
    assert.doesNotThrow(() => requireAccessToken("secret"));
  });
});

test("AI proxy is closed by default when no public opt-in is set", () => {
  withEnv({ [ACCESS_TOKEN_ENV]: undefined, [AI_PROXY_PUBLIC_ENV]: undefined }, () => {
    const request = new Request("https://example.test/ai/chat/completions", { method: "POST" });
    assert.equal(isPublicAiProxyAllowed(), false);
    assert.throws(() => requireAiProxyAccess(request), /AI proxy disabled/);
  });
});

test("AI proxy accepts the configured header token without making the whole proxy public", () => {
  withEnv({ [ACCESS_TOKEN_ENV]: "secret", [AI_PROXY_PUBLIC_ENV]: undefined }, () => {
    const request = new Request("https://example.test/ai/chat/completions", {
      method: "POST",
      headers: { "x-rilable-access-token": "secret" },
    });
    assert.equal(httpAccessToken(request), "secret");
    assert.doesNotThrow(() => requireAiProxyAccess(request));
  });
});

test("AI proxy can be explicitly made public for disposable demos", () => {
  withEnv({ [ACCESS_TOKEN_ENV]: undefined, [AI_PROXY_PUBLIC_ENV]: "true" }, () => {
    const request = new Request("https://example.test/ai/chat/completions", { method: "POST" });
    assert.equal(isPublicAiProxyAllowed(), true);
    assert.doesNotThrow(() => requireAiProxyAccess(request));
  });
});
