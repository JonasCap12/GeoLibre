import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import {
  appRootPath,
  captureSelfHostRoute,
  leaveSelfHostRoute,
  readSelfHostRoute,
  resetCapturedSelfHostRoute,
  urlWithoutToken,
} from "../apps/geolibre-desktop/src/lib/selfhost-routes";

/**
 * The invite, reset and email-change mails link to /register, /reset and
 * /verify-email with the token in the fragment. The gate must read those
 * before it checks for a saved token, take the token out of the address bar,
 * and spend nothing on load.
 */

const TOKEN = "AbCdEfGhIjKlMnOpQrStUvWxYz0123456789_-abcd";
const loc = (pathname: string, search = "", hash = "") => ({ pathname, search, hash });

describe("readSelfHostRoute", () => {
  it("reads the token from the fragment", () => {
    assert.deepEqual(readSelfHostRoute(loc("/register", "", `#invite=${TOKEN}`)), {
      page: "register",
      token: TOKEN,
    });
    assert.deepEqual(readSelfHostRoute(loc("/reset", "", `#token=${TOKEN}`)), {
      page: "reset",
      token: TOKEN,
    });
    assert.deepEqual(readSelfHostRoute(loc("/verify-email", "", `#token=${TOKEN}`)), {
      page: "verify-email",
      token: TOKEN,
    });
  });

  it("still reads the query string, for links mailed before the change", () => {
    assert.deepEqual(readSelfHostRoute(loc("/register", `?invite=${TOKEN}`)), {
      page: "register",
      token: TOKEN,
    });
  });

  it("works under a base path and with a trailing slash", () => {
    assert.equal(readSelfHostRoute(loc("/geolibre/reset/", "", `#token=${TOKEN}`)).page, "reset");
  });

  it("treats a malformed or missing token as invalid rather than guessing", () => {
    assert.deepEqual(readSelfHostRoute(loc("/register", "", "#invite=<script>")), {
      page: "register",
      token: null,
    });
    assert.deepEqual(readSelfHostRoute(loc("/reset")), { page: "reset", token: null });
  });

  it("leaves every other path to the app", () => {
    assert.deepEqual(readSelfHostRoute(loc("/", `?invite=${TOKEN}`)), { page: "app" });
    assert.deepEqual(readSelfHostRoute(loc("/projects/register-form")), { page: "app" });
  });
});

describe("urlWithoutToken", () => {
  it("removes the token from both places and keeps other parameters", () => {
    assert.equal(
      urlWithoutToken(loc("/register", `?locale=vi&invite=${TOKEN}`, `#invite=${TOKEN}`)),
      "/register?locale=vi",
    );
    assert.equal(urlWithoutToken(loc("/reset", "", `#token=${TOKEN}`)), "/reset");
  });
});

describe("appRootPath", () => {
  it("drops the link page segment", () => {
    assert.equal(appRootPath("/register"), "/");
    assert.equal(appRootPath("/geolibre/reset"), "/geolibre/");
    assert.equal(appRootPath("/"), "/");
  });
});

describe("captureSelfHostRoute", () => {
  afterEach(() => resetCapturedSelfHostRoute());

  function fakeWindow(href: string) {
    const url = new URL(href);
    const replaced: string[] = [];
    const win = {
      location: {
        get pathname() {
          return url.pathname;
        },
        get search() {
          return url.search;
        },
        get hash() {
          return url.hash;
        },
      },
      history: {
        state: null,
        replaceState(_state: unknown, _title: string, next: string) {
          replaced.push(next);
          const updated = new URL(next, url);
          url.pathname = updated.pathname;
          url.search = updated.search;
          url.hash = updated.hash;
        },
      },
    } as unknown as Window;
    return { win, replaced, url };
  }

  it("strips the token from the address bar once, and keeps the result", () => {
    const { win, replaced } = fakeWindow(`https://app.example.test/register#invite=${TOKEN}`);
    const first = captureSelfHostRoute(win);
    assert.deepEqual(first, { page: "register", token: TOKEN });
    assert.deepEqual(replaced, ["/register"]);
    // StrictMode runs initialisers twice; the second call must not lose the token.
    assert.deepEqual(captureSelfHostRoute(win), first);
    assert.equal(replaced.length, 1);
  });

  it("does not touch the address bar for the app itself", () => {
    const { win, replaced } = fakeWindow("https://app.example.test/?project=abc");
    assert.deepEqual(captureSelfHostRoute(win), { page: "app" });
    assert.equal(replaced.length, 0);
  });

  it("leaves a link page for the app root", () => {
    const { win, url } = fakeWindow(`https://app.example.test/reset?locale=vi#token=${TOKEN}`);
    captureSelfHostRoute(win);
    leaveSelfHostRoute(win);
    assert.equal(`${url.pathname}${url.search}`, "/?locale=vi");
    assert.deepEqual(captureSelfHostRoute(win), { page: "app" });
  });
});
