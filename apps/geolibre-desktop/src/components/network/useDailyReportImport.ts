import { useCallback, useEffect, useRef, useState } from "react";

/** Temporarily reveal the board only for a review requested by the panels. */
export function useDailyReportImport() {
  const frame = useRef<HTMLIFrameElement>(null);
  const pending = useRef(false);
  const [reviewing, setReviewing] = useState(false);

  const loadReports = useCallback(() => {
    const input = frame.current?.contentDocument?.getElementById("fileIn");
    if (!input) return;
    pending.current = true;
    // A cancelled picker fires "cancel" and no "change": nothing is coming to review.
    const settle = (event: Event) => {
      if (event.type === "cancel") pending.current = false;
      input.removeEventListener("cancel", settle);
      input.removeEventListener("change", settle);
    };
    input.addEventListener("cancel", settle);
    input.addEventListener("change", settle);
    // Stay in the user's click stack so the browser retains user activation.
    // Bypass #bUp: it syncs instead of opening a picker when a source is saved.
    input.click();
  }, []);

  const onReviewChange = useCallback((open: boolean) => {
    if (!pending.current) return;
    setReviewing(open);
    if (!open) pending.current = false;
  }, []);

  // The click happened in the dashboard, so keyboard focus is still there: move it
  // into the board's review once it is shown, so Escape and Tab reach the dialog.
  useEffect(() => {
    if (!reviewing) return;
    const board = frame.current;
    board?.contentWindow?.focus();
    board?.contentDocument?.querySelector<HTMLElement>("#upOv button")?.focus();
  }, [reviewing]);

  const chooseView = useCallback(() => {
    // An explicit view choice takes ownership, even while a review is open.
    pending.current = false;
    setReviewing(false);
  }, []);

  // The preferred view remains untouched throughout the temporary review.
  return { frame, reviewing, loadReports, onReviewChange, chooseView };
}
