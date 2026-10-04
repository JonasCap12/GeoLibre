import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import { verifyIdentityToken } from "../packages/collab-core/src/identity";
import { createSession } from "../apps/geolibre-desktop/src/lib/collab-client";
import {
  COLLAB_IDENTITY_TTL_SECONDS,
  signCollabIdentity,
} from "../workers/projects-api/src/collab-identity";
import { attachmentDisposition } from "../workers/projects-api/src/datasets";
import { API_SECURITY_HEADERS, isAuthRoute } from "../workers/projects-api/src/public-routes";
import { parseProxyOrigins } from "../workers/tiles/src/index";
import { sameSecret } from "../workers/collab/src/secret-equal";

const SECRET = "test-secret-0123456789abcdef";
const read = (path: string) => readFileSync(new URL(path, import.meta.url), "utf8");

describe("collaboration identity issuer", () => {
  const nowS = Math.floor(Date.now() / 1000);

  it("mints tokens the relay's own verifier accepts", async () => {
    const token = await signCollabIdentity(
      { provider: "geolibre", userId: "acct-1", username: "nhut", exp: nowS + 600 },
      SECRET,
    );
    const identity = await verifyIdentityToken(token, SECRET);
    assert.deepEqual(identity, { provider: "geolibre", userId: "acct-1", username: "nhut" });
  });

  it("keeps a Vietnamese username intact", async () => {
    const token = await signCollabIdentity(
      { provider: "geolibre", userId: "acct-2", username: "nguyễn-văn-a", exp: nowS + 600 },
      SECRET,
    );
    assert.equal((await verifyIdentityToken(token, SECRET))?.username, "nguyễn-văn-a");
  });

  it("is refused with another secret, once expired, or when tampered with", async () => {
    const token = await signCollabIdentity(
      { provider: "geolibre", userId: "acct-1", username: "nhut", exp: nowS + 600 },
      SECRET,
    );
    assert.equal(await verifyIdentityToken(token, "another-secret"), null);
    assert.equal(await verifyIdentityToken(token, SECRET, (nowS + 601) * 1000), null);
    const [payload, signature] = token.split(".");
    const forged = Buffer.from(
      JSON.stringify({ provider: "geolibre", userId: "admin", username: "x", exp: nowS + 600 }),
    ).toString("base64url");
    assert.equal(await verifyIdentityToken(`${forged}.${signature}`, SECRET), null);
    assert.ok(payload);
  });

  it("lasts a working session, not indefinitely", () => {
    assert.ok(COLLAB_IDENTITY_TTL_SECONDS >= 60 * 60);
    assert.ok(COLLAB_IDENTITY_TTL_SECONDS <= 24 * 60 * 60);
  });

  it("is never cached", () => {
    assert.ok(isAuthRoute(["api", "collab", "identity"]));
  });
});

describe("relay client", () => {
  it("sends the identity token, and shows the relay's reason for a refusal", async () => {
    let sent: Record<string, unknown> = {};
    const fetchImpl = (async (_url: RequestInfo | URL, init: RequestInit = {}) => {
      sent = JSON.parse(String(init.body));
      return Response.json(
        { error: "Sign in to this deployment to start a session." },
        {
          status: 401,
        },
      );
    }) as typeof fetch;
    await assert.rejects(
      createSession({ mode: "co-edit", identityToken: "tok" }, "wss://relay.test", fetchImpl),
      /Sign in to this deployment/,
    );
    assert.equal(sent.identityToken, "tok");
  });
});

describe("API response headers", () => {
  it("forbid rendering, framing and sniffing anything the API serves", () => {
    assert.match(API_SECURITY_HEADERS["Content-Security-Policy"], /default-src 'none'/);
    assert.match(API_SECURITY_HEADERS["Content-Security-Policy"], /frame-ancestors 'none'/);
    assert.match(API_SECURITY_HEADERS["Content-Security-Policy"], /sandbox/);
    assert.equal(API_SECURITY_HEADERS["X-Content-Type-Options"], "nosniff");
    assert.match(API_SECURITY_HEADERS["Strict-Transport-Security"], /max-age=\d{7,}/);
  });

  it("apply to every response, errors and preflights included", () => {
    const source = read("../workers/projects-api/src/index.ts");
    assert.match(source, /Object\.entries\(API_SECURITY_HEADERS\)\) headers\.set/);
    assert.match(source, /headers: \{ \.\.\.cors, \.\.\.API_SECURITY_HEADERS \}/);
  });
});

describe("dataset download names", () => {
  it("carries a Unicode name in filename* and a safe ASCII one in filename", () => {
    const value = attachmentDisposition("bản đồ khu A.dxf");
    assert.match(value, /^attachment; filename="[\x20-\x7e]+"; filename\*=UTF-8''/);
    assert.ok(value.includes("b%E1%BA%A3n%20%C4%91%E1%BB%93%20khu%20A.dxf"));
    // Must be a ByteString, or the Worker throws building the response.
    assert.ok([...value].every((char) => char.charCodeAt(0) <= 0xff));
  });

  it("cannot be broken out of with quotes, backslashes or line breaks", () => {
    const value = attachmentDisposition('a"b\\c\r\nSet-Cookie: x=1.zip');
    assert.ok(!/[\r\n]/.test(value));
    const ascii = /filename="([^"]*)"/.exec(value)?.[1] ?? "";
    assert.ok(!ascii.includes("\\"));
    assert.equal(value.match(/"/g)?.length, 2);
  });
});

describe("tiles proxy origins", () => {
  it("accepts exact https origins only", () => {
    const origins = parseProxyOrigins(" https://gis.jonasnguyen.uk/ , *, http://plain.test, nope");
    assert.deepEqual([...origins], ["https://gis.jonasnguyen.uk"]);
    assert.equal(parseProxyOrigins(undefined).size, 0);
  });
});

describe("deployment config", () => {
  it("makes the relay members-only", () => {
    assert.match(
      read("../workers/collab/wrangler.selfhost.jsonc"),
      /"COLLAB_REQUIRE_IDENTITY": "1"/,
    );
  });

  it("lets the custom domain use the tiles proxy routes", () => {
    assert.match(
      read("../workers/tiles/wrangler.selfhost.jsonc"),
      /"ALLOWED_PROXY_ORIGINS": "https:\/\/gis\.jonasnguyen\.uk"/,
    );
  });

  it("refuses to deploy the API without the identity secret", () => {
    assert.match(
      read("../workers/projects-api/scripts/predeploy-check.mjs"),
      /COLLAB_IDENTITY_SECRET/,
    );
  });

  it("sends HSTS, a permissions policy and COOP with the web app", () => {
    const headers = read("../apps/geolibre-desktop/public/_headers");
    assert.match(headers, /^ {2}Strict-Transport-Security: max-age=31536000/m);
    assert.match(headers, /^ {2}Permissions-Policy: camera=\(\), microphone=\(\)/m);
    assert.match(headers, /^ {2}Cross-Origin-Opener-Policy: same-origin-allow-popups$/m);
  });

  it("repeats those headers on the Worker-built shell and on JupyterLite", () => {
    const source = read("../workers/web/src/index.ts");
    assert.match(source, /Strict-Transport-Security", "max-age=31536000; includeSubDomains"/);
    assert.match(source, /Cross-Origin-Opener-Policy", "same-origin-allow-popups"/);
    assert.equal(source.match(/applyAppSecurityHeaders\(headers\)/g)?.length, 2);
  });
});

describe("host token comparison", () => {
  it("matches only the whole secret, including when the lengths differ", () => {
    assert.equal(sameSecret("host-token-aaa", "host-token-aaa"), true);
    assert.equal(sameSecret("host-token-aaa", "host-token-aab"), false);
    assert.equal(sameSecret("short", "host-token-aaa"), false);
    assert.equal(sameSecret("", ""), true);
  });
});
