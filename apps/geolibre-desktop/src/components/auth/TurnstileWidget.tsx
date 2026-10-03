import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { loadTurnstile, resolveTurnstileSiteKey, type TurnstileAction } from "../../lib/turnstile";

interface TurnstileWidgetProps {
  action: TurnstileAction;
  /** The current response, or null while there is none (or it expired). */
  onToken: (token: string | null) => void;
  /**
   * Bump after each submit. A response is single-use on the server, so a
   * retry after an error needs a fresh one.
   */
  resetKey: number;
}

/** Whether forms should wait for a Turnstile response before submitting. */
export function turnstileRequired(): boolean {
  return resolveTurnstileSiteKey() !== null;
}

export function TurnstileWidget({ action, onToken, resetKey }: TurnstileWidgetProps) {
  const { t, i18n } = useTranslation();
  const container = useRef<HTMLDivElement>(null);
  const widget = useRef<string | null>(null);
  const [failed, setFailed] = useState(false);
  const siteKey = resolveTurnstileSiteKey();
  const tokenSink = useRef(onToken);
  useEffect(() => {
    tokenSink.current = onToken;
  });

  useEffect(() => {
    if (siteKey === null || container.current === null) return;
    let cancelled = false;
    const element = container.current;
    loadTurnstile()
      .then((api) => {
        if (cancelled) return;
        widget.current = api.render(element, {
          sitekey: siteKey,
          action,
          theme: "auto",
          language: i18n.resolvedLanguage,
          callback: (token) => tokenSink.current(token),
          "expired-callback": () => tokenSink.current(null),
          "error-callback": () => tokenSink.current(null),
        });
      })
      .catch(() => {
        if (!cancelled) setFailed(true);
      });
    return () => {
      cancelled = true;
      if (widget.current !== null) window.turnstile?.remove(widget.current);
      widget.current = null;
    };
  }, [siteKey, action, i18n.resolvedLanguage]);

  useEffect(() => {
    if (resetKey === 0 || widget.current === null) return;
    tokenSink.current(null);
    window.turnstile?.reset(widget.current);
  }, [resetKey]);

  if (siteKey === null) return null;
  return (
    <div className="space-y-1">
      <div ref={container} />
      {failed ? (
        <p className="text-xs text-destructive" role="alert">
          {t("auth.botCheckLoadFailed")}
        </p>
      ) : null}
    </div>
  );
}
