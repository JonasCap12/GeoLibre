import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  SELFHOST_AUTH_ENV,
  resolveSelfHostAuth,
} from "../apps/geolibre-desktop/src/lib/selfhost-auth.ts";

describe("self-hosted sign-in flag", () => {
  it("stays disabled when the variable is absent", () => {
    assert.equal(resolveSelfHostAuth(true, {}, {}), false);
  });

  it("stays disabled for a blank or non-truthy value", () => {
    assert.equal(resolveSelfHostAuth(true, { [SELFHOST_AUTH_ENV]: "" }, {}), false);
    assert.equal(resolveSelfHostAuth(true, { [SELFHOST_AUTH_ENV]: "false" }, {}), false);
    assert.equal(resolveSelfHostAuth(true, { [SELFHOST_AUTH_ENV]: "0" }, {}), false);
  });

  it("prefers the deployment env over the build env", () => {
    assert.equal(
      resolveSelfHostAuth(true, { [SELFHOST_AUTH_ENV]: "1" }, { [SELFHOST_AUTH_ENV]: "false" }),
      true,
    );
    assert.equal(
      resolveSelfHostAuth(true, { [SELFHOST_AUTH_ENV]: "false" }, { [SELFHOST_AUTH_ENV]: "1" }),
      false,
    );
  });

  it("accepts the build env when the deployment does not name it", () => {
    assert.equal(resolveSelfHostAuth(true, {}, { [SELFHOST_AUTH_ENV]: "true" }), true);
  });

  it("never gates native or embedded applications", () => {
    assert.equal(
      resolveSelfHostAuth(false, { [SELFHOST_AUTH_ENV]: "1" }, { [SELFHOST_AUTH_ENV]: "1" }),
      false,
    );
  });
});
