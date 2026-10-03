import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { describeUserAgent } from "../apps/geolibre-desktop/src/lib/user-agent";

describe("describeUserAgent", () => {
  const cases: Array<[string, string, string]> = [
    [
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/148.0.0.0 Safari/537.36",
      "Chrome 148",
      "Windows",
    ],
    [
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36 Edg/140.0.0.0",
      "Edge 140",
      "Windows",
    ],
    [
      "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.2 Safari/605.1.15",
      "Safari 18",
      "macOS",
    ],
    [
      "Mozilla/5.0 (iPhone; CPU iPhone OS 18_2 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.2 Mobile/15E148 Safari/604.1",
      "Safari 18",
      "iOS",
    ],
    [
      "Mozilla/5.0 (X11; Ubuntu; Linux x86_64; rv:133.0) Gecko/20100101 Firefox/133.0",
      "Firefox 133",
      "Linux",
    ],
    [
      "Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Mobile Safari/537.36",
      "Chrome 131",
      "Android",
    ],
  ];

  for (const [ua, browser, os] of cases) {
    it(`reads ${browser} on ${os}`, () => {
      assert.deepEqual(describeUserAgent(ua), { browser, os });
    });
  }

  it("returns null for empty or unrecognised headers", () => {
    assert.equal(describeUserAgent(null), null);
    assert.equal(describeUserAgent(""), null);
    assert.equal(describeUserAgent("curl/8.9.1"), null);
    assert.equal(describeUserAgent("SmokeAgent/1.0 (Windows)"), null);
  });
});
