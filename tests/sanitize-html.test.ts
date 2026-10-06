import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { safeImageSrc } from "../apps/geolibre-desktop/src/lib/sanitize-html";

describe("safeImageSrc", () => {
  it("keeps an https URL and an image data URI", () => {
    assert.equal(
      safeImageSrc("https://opengeos.org/maplibre-gl-storymaps/assets/tokyo.jpg"),
      "https://opengeos.org/maplibre-gl-storymaps/assets/tokyo.jpg",
    );
    assert.equal(safeImageSrc("  data:image/png;base64,AAAA  "), "data:image/png;base64,AAAA");
    assert.equal(
      safeImageSrc("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg'/%3E"),
      "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg'/%3E",
    );
  });

  it("drops schemes the chapter editor does not write", () => {
    assert.equal(safeImageSrc(""), null);
    assert.equal(safeImageSrc("http://evil.example/pixel.png"), null);
    assert.equal(safeImageSrc("javascript:alert(1)"), null);
    assert.equal(safeImageSrc("blob:http://localhost/11111111-1111-1111-1111-111111111111"), null);
    assert.equal(safeImageSrc("asset://localhost/photo.png"), null);
    assert.equal(safeImageSrc("//evil.example/pixel.png"), null);
    assert.equal(safeImageSrc("data:text/html,<script>alert(1)</script>"), null);
  });
});
