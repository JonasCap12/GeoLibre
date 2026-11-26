import { useEffect, useMemo, useState } from "react";
import {
  parseBoardReport,
  readBoardStore,
  type BoardReport,
  type ReportIndex,
} from "../../lib/daily-report-data";
import { groupHistory, historyKeys } from "../../lib/structure-card";

const EMPTY = new Map<string, BoardReport[]>();

/**
 * The earlier reports the structure cards compare against: for each shown
 * report, its package's reports within the history window, newest first.
 * Read-only, in one transaction; re-read when the shown reports change.
 */
export function useReportHistory(
  index: ReportIndex | null,
  reports: readonly BoardReport[],
): ReadonlyMap<string, readonly BoardReport[]> {
  const keys = useMemo(() => (index ? historyKeys(index, reports) : []), [index, reports]);
  const signature = keys.join("\n");
  const [history, setHistory] = useState<ReadonlyMap<string, readonly BoardReport[]>>(EMPTY);

  useEffect(() => {
    let live = true;
    const wanted = signature ? signature.split("\n") : [];
    if (!wanted.length) {
      setHistory(EMPTY);
      return;
    }
    void readBoardStore(window, "docs", wanted).then((docs) => {
      if (!live) return;
      const parsed = [...(docs?.values() ?? [])].flatMap((value) => parseBoardReport(value) ?? []);
      setHistory(groupHistory(parsed));
    });
    return () => {
      live = false;
    };
    // `index` is re-read whenever the board writes, so a re-imported day refreshes too.
  }, [signature, index]);

  return history;
}
