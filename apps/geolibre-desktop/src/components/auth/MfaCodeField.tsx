import { Input, Label } from "@geolibre/ui";
import { useTranslation } from "react-i18next";

/**
 * The second-factor input: six digits from an authenticator app, or a
 * recovery code. One field for both, as the server tells them apart.
 *
 * Not `inputMode="numeric"`: recovery codes have letters, and a numeric
 * keypad would hide them on a phone.
 */
export function MfaCodeField({
  id,
  value,
  onChange,
  label,
  autoFocus = false,
}: {
  id: string;
  value: string;
  onChange: (value: string) => void;
  label?: string;
  autoFocus?: boolean;
}) {
  const { t } = useTranslation();
  return (
    <div className="space-y-1.5">
      <Label htmlFor={id}>{label ?? t("auth.mfa.code")}</Label>
      <Input
        id={id}
        autoComplete="one-time-code"
        autoCapitalize="characters"
        autoCorrect="off"
        spellCheck={false}
        maxLength={40}
        autoFocus={autoFocus}
        value={value}
        onChange={(event) => onChange(event.target.value)}
        aria-describedby={`${id}-hint`}
      />
      <p id={`${id}-hint`} className="text-xs text-muted-foreground">
        {t("auth.mfa.codeHint")}
      </p>
    </div>
  );
}
