import { Check, Circle, X } from "lucide-react";
import { useTranslation } from "react-i18next";
import {
  MIN_PASSWORD_LENGTH,
  MIN_PASSWORD_SCORE,
  checkPassword,
  type PasswordContext,
  type PasswordScore,
} from "../../lib/password-strength";

const LEVEL_KEYS = {
  0: "auth.strength.level.0",
  1: "auth.strength.level.1",
  2: "auth.strength.level.2",
  3: "auth.strength.level.3",
  4: "auth.strength.level.4",
} as const satisfies Record<PasswordScore, string>;

const BAR_COLORS: Record<PasswordScore, string> = {
  0: "bg-red-500",
  1: "bg-orange-500",
  2: "bg-amber-500",
  3: "bg-emerald-500",
  4: "bg-emerald-600",
};

const LABEL_COLORS: Record<PasswordScore, string> = {
  0: "text-red-600 dark:text-red-400",
  1: "text-orange-600 dark:text-orange-400",
  2: "text-amber-600 dark:text-amber-400",
  3: "text-emerald-600 dark:text-emerald-400",
  4: "text-emerald-700 dark:text-emerald-300",
};

/**
 * Live feedback under a new-password field: a four-step strength bar and the
 * rules the server will apply, each ticked as it is met.
 *
 * The rules come from password-strength.ts, the same file the API enforces,
 * so a password the checklist accepts is one the server accepts too, apart
 * from the breach lookup, which needs the server and is said so here.
 */
export function PasswordStrength({
  id,
  password,
  context = {},
}: {
  id: string;
  password: string;
  context?: PasswordContext;
}) {
  const { t } = useTranslation();
  const check = checkPassword(password, context);
  const empty = password === "";
  const filled = empty ? 0 : Math.max(1, check.score);
  const rules = [
    {
      met: check.longEnough && !check.tooLong,
      label: t("auth.strength.rule.length", { count: MIN_PASSWORD_LENGTH }),
    },
    { met: check.notPersonal, label: t("auth.strength.rule.personal") },
    { met: check.notPredictable, label: t("auth.strength.rule.predictable") },
    {
      met: check.strongEnough,
      label: t("auth.strength.rule.strength", { level: t(LEVEL_KEYS[MIN_PASSWORD_SCORE]) }),
    },
  ];

  return (
    <div id={id} className="space-y-2 rounded-md border bg-muted/30 p-3 text-xs">
      <div className="flex items-center gap-3">
        <div className="flex flex-1 gap-1" aria-hidden>
          {[1, 2, 3, 4].map((step) => (
            <span
              key={step}
              className={`h-1.5 flex-1 rounded-full transition-colors ${
                step <= filled ? BAR_COLORS[check.score] : "bg-muted-foreground/20"
              }`}
            />
          ))}
        </div>
        <span
          aria-live="polite"
          className={`min-w-[5.5rem] text-end font-medium ${
            empty ? "text-muted-foreground" : LABEL_COLORS[check.score]
          }`}
        >
          {empty ? t("auth.strength.empty") : t(LEVEL_KEYS[check.score])}
        </span>
      </div>
      <ul className="space-y-1">
        {rules.map((rule) => (
          <li key={rule.label} className="flex items-start gap-1.5 text-start">
            {empty ? (
              <Circle
                className="mt-0.5 h-3.5 w-3.5 shrink-0 text-muted-foreground/60"
                aria-hidden
              />
            ) : rule.met ? (
              <Check
                className="mt-0.5 h-3.5 w-3.5 shrink-0 text-emerald-600 dark:text-emerald-400"
                aria-hidden
              />
            ) : (
              <X
                className="mt-0.5 h-3.5 w-3.5 shrink-0 text-red-600 dark:text-red-400"
                aria-hidden
              />
            )}
            <span className={empty || rule.met ? "text-muted-foreground" : "text-foreground"}>
              <span className="sr-only">
                {empty ? "" : rule.met ? t("auth.strength.met") : t("auth.strength.notMet")}
              </span>
              {rule.label}
            </span>
          </li>
        ))}
      </ul>
      <p className="text-muted-foreground">{t("auth.strength.tip")}</p>
      <p className="text-muted-foreground">{t("auth.strength.breachNote")}</p>
    </div>
  );
}

/** "Passwords match" or "do not match yet", once the confirmation has been typed. */
export function PasswordMatch({ password, confirm }: { password: string; confirm: string }) {
  const { t } = useTranslation();
  if (confirm === "") return null;
  const same = password === confirm;
  const Icon = same ? Check : X;
  return (
    <p
      aria-live="polite"
      className={`flex items-center gap-1.5 text-xs ${
        same ? "text-emerald-600 dark:text-emerald-400" : "text-red-600 dark:text-red-400"
      }`}
    >
      <Icon className="h-3.5 w-3.5" aria-hidden />
      {same ? t("auth.strength.match") : t("auth.strength.mismatch")}
    </p>
  );
}
