import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  MAX_TAGS,
  MAX_TAG_LENGTH,
  normalizeTags,
  readTags,
  searchLikePattern,
  tagLikePattern,
} from "../workers/projects-api/src/datasets.ts";

/**
 * A shared library with five files needs no search. One holding fifty road
 * projects' drawings does, or it becomes a place things go in and never come
 * out of — worse than no library, because people stop trusting it.
 *
 * Tags are stored as one comma-separated column with sentinel commas at both
 * ends, so a filter can match a whole tag. The alternative, a join table, is
 * the textbook answer and costs a query per listing plus D1 row reads to model
 * a relationship never queried from the other side.
 */

describe("normalizeTags", () => {
  it("wraps the set in sentinel commas", () => {
    // `,road,bridge,` is what makes LIKE '%,road,%' match a whole tag. Without
    // the sentinels, filtering for "road" would also match "railroad".
    assert.equal(normalizeTags("road, bridge"), ",road,bridge,");
  });

  it("lowercases so one tag is not two", () => {
    assert.equal(normalizeTags("Road,ROAD,road"), ",road,");
  });

  it("drops duplicates and blanks", () => {
    assert.equal(normalizeTags("road,,  ,road , bridge"), ",road,bridge,");
  });

  it("stores nothing for an empty set", () => {
    // `""`, not `,,`: a dataset with no tags must match no tag filter, and
    // `,,` contains `,` + `,` which a careless pattern could match.
    for (const input of ["", "   ", ",,,", null, undefined]) {
      assert.equal(normalizeTags(input), "", JSON.stringify(input));
    }
  });

  it("strips commas inside a tag rather than rejecting the upload", () => {
    // A tag is free text someone typed. One stray comma must not fail the
    // upload, and must not silently split one tag into two on the way out.
    assert.equal(normalizeTags("Lâm Đồng, cầu đường"), ",lâm đồng,cầu đường,");
    assert.deepEqual(readTags(normalizeTags("a,,b")), ["a", "b"]);
  });

  it("caps the count and the length", () => {
    const many = Array.from({ length: MAX_TAGS + 8 }, (_, i) => `tag${i}`).join(",");
    assert.equal(readTags(normalizeTags(many)).length, MAX_TAGS);
    const long = "x".repeat(MAX_TAG_LENGTH + 40);
    assert.equal(readTags(normalizeTags(long))[0].length, MAX_TAG_LENGTH);
  });

  it("round-trips through readTags", () => {
    assert.deepEqual(readTags(normalizeTags("road,bridge,survey")), ["road", "bridge", "survey"]);
    assert.deepEqual(readTags(""), []);
    assert.deepEqual(readTags(null), []);
  });
});

describe("tagLikePattern", () => {
  it("matches a whole tag, not a fragment of another", () => {
    const pattern = tagLikePattern("road");
    assert.equal(pattern, "%,road,%");
    // The behaviour the sentinels buy, spelled out as the SQL would see it.
    const railroad = normalizeTags("railroad");
    assert.ok(!railroad.includes(",road,"), "railroad must not contain the road pattern");
    assert.ok(normalizeTags("road").includes(",road,"));
  });

  it("returns null when there is nothing to filter by", () => {
    for (const input of ["", "  ", ",", null, undefined]) {
      assert.equal(tagLikePattern(input), null, JSON.stringify(input));
    }
  });
});

describe("searchLikePattern", () => {
  it("lowercases and wraps", () => {
    assert.equal(searchLikePattern("Cầu"), "%cầu%");
  });

  it("escapes SQL wildcards", () => {
    // Unescaped, "%" matches everything and "_" matches any character, so
    // searching a filename with an underscore — which is most of them —
    // returns rows that do not contain what was typed.
    assert.equal(searchLikePattern("BL_LK"), "%bl\\_lk%");
    assert.equal(searchLikePattern("100%"), "%100\\%%");
    assert.equal(searchLikePattern("a\\b"), "%a\\\\b%");
  });

  it("returns null for an empty query so the filter is skipped", () => {
    for (const input of ["", "   ", null, undefined]) {
      assert.equal(searchLikePattern(input), null, JSON.stringify(input));
    }
  });

  it("caps the query length", () => {
    const long = "a".repeat(500);
    assert.equal(searchLikePattern(long)!.length, 200 + 2);
  });
});
