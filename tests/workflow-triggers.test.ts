import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { describe, it } from "node:test";

/**
 * Which workflows are allowed to run themselves.
 *
 * Upstream ships deploy workflows for infrastructure only it owns: Workers on
 * `*.geolibre.app` custom domains, and GitHub Pages sites under that domain.
 * On this fork every one of them fails, and three of them fired on *every*
 * push to main because they carry no path filter. The result was a wall of red
 * X's that had nothing to do with the code, which is worse than no check at
 * all -- a run that always fails teaches everyone to ignore the ones that
 * matter, and a real failure hides among them.
 *
 * Their push triggers are removed rather than the files deleted, so an upstream
 * sync produces an ordinary edit conflict instead of a delete/modify one, and
 * so anyone who does own those domains can still run them by hand.
 *
 * This test exists because a sync can quietly restore the trigger: the diff
 * would look like an upstream improvement, and nothing else would complain.
 */

const DIR = new URL("../.github/workflows/", import.meta.url);

/** Upstream deploys that target infrastructure this fork does not own. */
const MANUAL_ONLY = [
  "deploy-collab.yml",
  "deploy-tiles.yml",
  "deploy-viewer.yml",
  "studio-deploy.yml",
  "web-deploy.yml",
  "pages.yml",
];

/** This fork's own deploys, which must keep firing on a push to main. */
const MUST_AUTO_DEPLOY = [
  "deploy-web-worker.yml",
  "deploy-projects-api.yml",
  "deploy-collab-selfhost.yml",
  "deploy-tiles-selfhost.yml",
];

/**
 * The body of a workflow's `on:` block.
 *
 * Read as text rather than through a YAML parser: `on` is a YAML 1.1 boolean
 * keyword, so parsers disagree about whether the key is `on` or `true`, and a
 * test that guards CI should not depend on which one this month's parser picks.
 */
function triggerBlock(source: string): string {
  const lines = source.split(/\r?\n/);
  const start = lines.findIndex((line) => /^on:\s*$/.test(line) || /^on:\s*\S/.test(line));
  if (start === -1) return "";
  const body: string[] = [];
  for (const line of lines.slice(start + 1)) {
    // A new top-level key ends the block. Blank and indented lines continue it.
    if (/^\S/.test(line)) break;
    body.push(line);
  }
  return body.join("\n");
}

const files = readdirSync(DIR).filter((name) => name.endsWith(".yml"));

describe("workflow triggers", () => {
  it("scans the workflow directory it thinks it does", () => {
    // A wrong path would scan nothing and pass everything.
    assert.ok(files.length > 10, `only found ${files.length} workflows`);
    for (const name of [...MANUAL_ONLY, ...MUST_AUTO_DEPLOY]) {
      assert.ok(files.includes(name), `${name} is gone; update this test`);
    }
  });

  it("never runs an upstream deploy automatically", () => {
    for (const name of MANUAL_ONLY) {
      const block = triggerBlock(readFileSync(new URL(name, DIR), "utf8"));
      assert.ok(
        !/^\s+push:/m.test(block),
        `${name} would run on push again and fail: this fork does not own its target`,
      );
      assert.ok(
        !/^\s+pull_request:/m.test(block),
        `${name} would run on every pull request and fail`,
      );
      assert.match(block, /workflow_dispatch:/, `${name} should still be runnable by hand`);
    }
  });

  it("keeps this fork's own deploys firing on main", () => {
    // The other half of the same risk: a sync that rewrote these would stop
    // the app deploying, and nothing would fail -- it would just go quiet.
    for (const name of MUST_AUTO_DEPLOY) {
      const block = triggerBlock(readFileSync(new URL(name, DIR), "utf8"));
      assert.match(block, /^\s+push:/m, `${name} no longer deploys on a push`);
      assert.match(block, /branches:\s*\[main\]/, `${name} no longer watches main`);
    }
  });

  it("pairs every disabled upstream deploy with a replacement or a reason", () => {
    for (const name of MANUAL_ONLY) {
      const source = readFileSync(new URL(name, DIR), "utf8");
      assert.match(
        source,
        /FORK CHANGE/,
        `${name} was disabled without saying why; the next person will just re-enable it`,
      );
    }
  });
});
