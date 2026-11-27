import { useCallback, useRef, useState } from "react";

/** Temporarily reveal the board only for a review requested by the panels. */
export function useDailyReportImport() {
  const frame = useRef<HTMLIFrameElement>(null);
  const pending = useRef(false);
  const [reviewing, setReviewing] = useState(false);

  const loadReports = useCallback(() => {
    const input = frame.current?.contentDocument?.getElementById("fileIn");
    if (!input) return;
    pending.current = true;
    // Stay in the user's click stack so the browser retains user activation.
    // Bypass #bUp: it syncs instead of opening a picker when a source is saved.
    input.click();
  }, []);

  const onReviewChange = useCallback((open: boolean) => {
    if (!pending.current) return;
    setReviewing(open);
    if (!open) pending.current = false;
  }, []);

  const chooseView = useCallback(() => {
    // An explicit view choice takes ownership, even while a review is open.
    pending.current = false;
    setReviewing(false);
  }, []);

  // The preferred view remains untouched throughout the temporary review.
  return { frame, reviewing, loadReports, onReviewChange, chooseView };
}
