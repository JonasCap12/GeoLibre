import type { Feature } from "geojson";

export type ProgressFeatureLink = (
  | { kind: "support" | "span" | "approach"; bridgeId: string; id: string }
  | { kind: "km" | "underpass"; id: string }
) & { pileIndex?: number; girderIndex?: number };

export function propertyText(feature: Feature, key: string): string {
  const value = feature.properties?.[key];
  return typeof value === "string" || typeof value === "number" ? String(value) : "";
}

export function propertyIndex(feature: Feature, key: string): number | null {
  const raw = feature.properties?.[key];
  if (raw == null || raw === "") return null;
  const value = Number(raw);
  return Number.isInteger(value) && value >= 0 ? value : null;
}

export function fold(value: string): string {
  return value
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/đ/g, "d");
}

export function slug(value: string): string {
  return fold(value)
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
}

/** Resolve both authored v2 IDs and legacy CAD labels without rewriting the drawing. */
export function progressFeatureLink(feature: Feature): ProgressFeatureLink | null {
  const component = propertyText(feature, "cau_kien");
  const structure = propertyText(feature, "cong_trinh");
  const bridgeId = propertyText(feature, "bridge_id") || (structure ? slug(structure) : "");
  const supportId = propertyText(feature, "support_id");
  const spanId = propertyText(feature, "span_id");
  const kmId = propertyText(feature, "km_id");
  const underpassId = propertyText(feature, "underpass_id");
  const item = fold(propertyText(feature, "progress_item"));
  let link: ProgressFeatureLink | null = null;
  if (bridgeId && supportId) link = { kind: "support", bridgeId, id: supportId };
  else if (bridgeId && spanId) link = { kind: "span", bridgeId, id: spanId };
  else if (kmId) link = { kind: "km", id: kmId };
  else if (underpassId) link = { kind: "underpass", id: underpassId };
  else if (bridgeId && ["ht", "approach"].includes(item))
    link = { kind: "approach", bridgeId, id: component || "approach" };
  else if (bridgeId && /^(M|T)\d+$/i.test(component))
    link = { kind: "support", bridgeId, id: component };
  else if (bridgeId && /^N\d+$/i.test(component)) link = { kind: "span", bridgeId, id: component };
  else if (bridgeId && /^dd\d+$/i.test(fold(component)))
    link = { kind: "approach", bridgeId, id: component };
  else if (/^Km\d+$/i.test(component)) link = { kind: "km", id: component };
  else if (/^HC\d+$/i.test(component)) link = { kind: "underpass", id: component };
  if (!link) return null;
  const index = (key: string, pattern: RegExp) => {
    if (key in (feature.properties ?? {})) return propertyIndex(feature, key);
    const match = fold(propertyText(feature, "bo_phan")).match(pattern);
    return match && Number(match[1]) > 0 ? Number(match[1]) - 1 : null;
  };
  if (link.kind === "support") {
    const value = index("pile_index", /^coc\s+(\d+)\b/);
    if (value !== null) link.pileIndex = value;
  }
  if (link.kind === "span") {
    const value = index("girder_index", /^dam\s+(\d+)\b/);
    if (value !== null) link.girderIndex = value;
  }
  return link;
}
