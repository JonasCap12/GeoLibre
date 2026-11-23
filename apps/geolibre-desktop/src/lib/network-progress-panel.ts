import { foldText, isNoDataValue, type NetworkSegment } from "./network-dashboard";

/** One row of the progress panel: a project line and its share of its group. */
export interface ProgressRow {
  segment: NetworkSegment;
  /** The name without the group's own prefix ("XL05 · Mũi 01" → "Mũi 01"). */
  label: string;
}

/** The lines of one category of the "type" field (a contract package, say). */
export interface ProgressGroup {
  key: string;
  label: string;
  km: number;
  /** Length-weighted percent done over the rows that report one, or null. */
  progress: number | null;
  /** Whether this is the package the report board is showing. */
  active: boolean;
  rows: ProgressRow[];
}

const collator = new Intl.Collator("vi", { numeric: true, sensitivity: "base" });

function rowLabel(name: string): string {
  const parts = name.split(" · ");
  return parts.length > 1 ? parts.slice(1).join(" · ") : name;
}

/** Whether a group label names the board's package ("Gói XL05" for "XL05"). */
function matchesPackage(label: string, code: string | null): boolean {
  if (!code) return false;
  const words = foldText(label).split(/[^a-z0-9]+/);
  return words.includes(foldText(code).replace(/[^a-z0-9]+/g, ""));
}

/**
 * Groups the dashboard's lines by their type field for the panel under the
 * report board: one card per group, its lines in natural name order.
 */
export function progressGroups(
  segments: readonly NetworkSegment[],
  boardPackage: string | null,
): ProgressGroup[] {
  const byKey = new Map<string, NetworkSegment[]>();
  for (const segment of segments) {
    const key = segment.type.trim();
    byKey.set(key, [...(byKey.get(key) ?? []), segment]);
  }
  const groups = [...byKey].map(([key, lines]): ProgressGroup => {
    const known = lines.filter((line) => line.progress !== null && line.km > 0);
    const knownKm = known.reduce((sum, line) => sum + line.km, 0);
    return {
      key,
      label: key,
      km: lines.reduce((sum, line) => sum + line.km, 0),
      progress:
        knownKm > 0
          ? known.reduce((sum, line) => sum + (line.progress ?? 0) * line.km, 0) / knownKm
          : null,
      active: matchesPackage(key, boardPackage),
      rows: [...lines]
        .sort((a, b) => collator.compare(a.name, b.name))
        .map((segment) => ({ segment, label: rowLabel(segment.name) })),
    };
  });
  const rank = (group: ProgressGroup) => (!group.key ? 2 : isNoDataValue(group.key) ? 1 : 0);
  return groups.sort((a, b) => rank(a) - rank(b) || collator.compare(a.label, b.label));
}
