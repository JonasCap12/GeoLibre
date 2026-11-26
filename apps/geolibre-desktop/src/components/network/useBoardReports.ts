import { useCallback, useEffect, useState } from "react";
import {
  firstPackage,
  latestDate,
  parseBoardReport,
  readBoardStore,
  readReport,
  readReportIndex,
  type BoardReport,
  type ReportIndex,
} from "../../lib/daily-report-data";

/** The board's stored reports, re-read whenever the board writes (BroadcastChannel "bcn"). */
export function useBoardReports() {
  const [index, setIndex] = useState<ReportIndex | null>(null);
  const [pkg, setPkg] = useState<string | null>(null);
  const [date, setDate] = useState<string | null>(null);
  const [report, setReport] = useState<BoardReport | null>(null);
  const [revision, setRevision] = useState(0);
  const [reports, setReports] = useState<BoardReport[]>([]);

  useEffect(() => {
    let channel: BroadcastChannel | null = null;
    try {
      channel = new BroadcastChannel("bcn");
      channel.onmessage = () => setRevision((value) => value + 1);
    } catch {
      /* Without the channel the panels refresh when the dashboard reopens. */
    }
    return () => channel?.close();
  }, []);

  useEffect(() => {
    let live = true;
    void readReportIndex(window).then((next) => {
      if (!live) return;
      setIndex(next ?? {});
    });
    return () => {
      live = false;
    };
  }, [revision]);

  // Keep the choice while it still exists; otherwise the first package, latest day.
  const shownPkg = pkg && index?.[pkg] ? pkg : index ? firstPackage(index) : null;
  const shownDate =
    date && shownPkg && index?.[shownPkg]?.includes(date)
      ? date
      : latestDate(index ?? {}, shownPkg);

  useEffect(() => {
    let live = true;
    const keys = Object.keys(index ?? {}).flatMap((code) => {
      const latest = latestDate(index ?? {}, code);
      return latest ? [`bcn_${code}/${latest}`] : [];
    });
    void readBoardStore(window, "docs", keys).then((docs) => {
      if (live)
        setReports([...(docs?.values() ?? [])].flatMap((value) => parseBoardReport(value) ?? []));
    });
    return () => {
      live = false;
    };
  }, [index, revision]);

  useEffect(() => {
    let live = true;
    if (!shownPkg || !shownDate) {
      setReport(null);
      return;
    }
    void readReport(window, shownPkg, shownDate).then((next) => {
      if (live) setReport(next);
    });
    return () => {
      live = false;
    };
  }, [shownPkg, shownDate, revision]);

  const choosePackage = useCallback((next: string) => {
    setPkg(next);
    setDate(null);
  }, []);
  const current = report && report.pkg === shownPkg && report.date === shownDate ? report : null;
  return {
    index,
    pkg: shownPkg,
    date: shownDate,
    report: current,
    reports: current ? [...reports.filter((item) => item.pkg !== current.pkg), current] : reports,
    choosePackage,
    chooseDate: setDate,
  };
}
