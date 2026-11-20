import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import entry from "../workers/web/src/index";

const worker = "fetch" in entry ? entry : (entry as unknown as { default: typeof entry }).default;
const read = (path: string) => readFileSync(new URL(path, import.meta.url), "utf8");
const DAILY_REPORT_CSP = read("../workers/web/src/index.ts").match(
  /const DAILY_REPORT_CSP =\s*"([^"]+)"/,
)![1];

describe("daily report board distribution", () => {
  it("preserves the original byte for byte except the early local storage flag", () => {
    const html = read("../apps/geolibre-desktop/public/daily-report/index.html");
    assert.ok(html.includes("<head><script>window.BCN_LOCAL = true;</script>"));
    const original = html.replace("<script>window.BCN_LOCAL = true;</script>", "");
    assert.equal(
      createHash("sha256").update(original).digest("hex"),
      "d75c9101dc4d5fb8933a89e2412bcd0d0396090658c33edee8f350b896067b22",
    );
  });

  it("routes through the Worker, excludes precaching and removes the board from embeds", () => {
    assert.match(
      read("../workers/web/wrangler.jsonc"),
      /"run_worker_first":\s*\[[^\]]*"\/daily-report\/\*"/,
    );
    const vite = read("../apps/geolibre-desktop/vite.config.ts");
    assert.ok(vite.includes('"**/daily-report/**"'));
    assert.match(vite, /if \(IS_EMBED\)\s+rmSync\(path.join\(outputDirectory, "daily-report"\)/);
    assert.match(vite, /removeDailyReportFromEmbedPlugin\(\),/);
  });

  it("sends the same single policy from nginx and the Worker", () => {
    const nginx = read("../docker/nginx.conf");
    const location = nginx.match(/location \^~ \/daily-report\/ \{([\s\S]*?)\n    \}/)?.[1];
    assert.ok(location);
    assert.match(location, /try_files \$uri \$uri\/ =404;/);
    assert.deepEqual(
      [...location.matchAll(/add_header Content-Security-Policy "([^"]+)"/g)].map((m) => m[1]),
      [DAILY_REPORT_CSP],
    );
    assert.ok(DAILY_REPORT_CSP.includes("frame-ancestors 'self'"));
    assert.ok(DAILY_REPORT_CSP.includes("font-src 'self' data:"));
    assert.ok(DAILY_REPORT_CSP.includes("script-src 'self' 'unsafe-inline' 'unsafe-eval' blob:"));
  });
});

describe("daily report Worker response", () => {
  for (const status of [200, 304, 404]) {
    it(`preserves asset status ${status} without an app fallback`, async () => {
      const request = new Request("https://app.test/daily-report/index.html");
      let calls = 0;
      const response = await worker.fetch(request, {
        ASSETS: {
          fetch: async (incoming: Request) => {
            calls++;
            assert.equal(incoming, request);
            return new Response(status === 304 ? null : "board", {
              status,
              headers: {
                "Content-Type": "text/html",
                "Content-Security-Policy": "default-src 'self', script-src 'none'",
              },
            });
          },
        },
      } as unknown as Parameters<typeof worker.fetch>[1]);
      assert.equal(calls, 1);
      assert.equal(response.status, status);
      if (status === 404) {
        assert.equal(await response.text(), "Not found");
        assert.equal(response.headers.get("Cache-Control"), "no-store");
      } else {
        assert.equal(response.headers.get("Content-Security-Policy"), DAILY_REPORT_CSP);
        assert.ok(!response.headers.get("Content-Security-Policy")!.includes(","));
        assert.equal(response.headers.get("X-Content-Type-Options"), "nosniff");
        assert.equal(response.headers.get("Cache-Control"), "no-cache, must-revalidate");
        assert.equal(
          response.headers.get("Cross-Origin-Opener-Policy"),
          "same-origin-allow-popups",
        );
      }
    });
  }
});
