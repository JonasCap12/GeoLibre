import type { TFunction } from "i18next";
import {
  MIN_PASSWORD_LENGTH,
  ShareAccountError,
  type AuthErrorCode,
} from "../../lib/share-account";

const KEYS = {
  unreachable: "auth.error.unreachable",
  "no-server": "auth.error.noServer",
  "rate-limited": "auth.error.rateLimited",
  "bad-credentials": "auth.error.badCredentials",
  disabled: "auth.error.disabled",
  "wrong-password": "auth.error.wrongPassword",
  "password-short": "auth.error.passwordShort",
  "password-long": "auth.error.passwordLong",
  "password-context": "auth.error.passwordContext",
  "password-breached": "auth.error.passwordBreached",
  "password-mismatch": "auth.error.passwordMismatch",
  "login-invalid": "auth.error.loginInvalid",
  "username-invalid": "auth.error.usernameInvalid",
  "email-invalid": "auth.error.emailInvalid",
  "email-same": "auth.error.emailSame",
  "invite-invalid": "auth.error.inviteInvalid",
  "reset-invalid": "auth.error.resetInvalid",
  "verify-invalid": "auth.error.verifyInvalid",
  "username-taken": "auth.error.usernameTaken",
  "email-taken": "auth.error.emailTaken",
  "bot-check": "auth.error.botCheck",
  "bot-unavailable": "auth.error.botUnavailable",
  "email-unconfigured": "auth.error.emailUnconfigured",
  "session-expired": "auth.error.sessionExpired",
  forbidden: "auth.error.forbidden",
} as const satisfies Record<Exclude<AuthErrorCode, "unknown">, string>;

/** The translated message for a code produced on the client. */
export function authCodeText(
  t: TFunction,
  code: AuthErrorCode,
  retryAfter?: number | null,
): string {
  if (code === "unknown") return t("auth.error.unknown");
  return t(KEYS[code], { count: MIN_PASSWORD_LENGTH, seconds: retryAfter ?? 60 });
}

/**
 * The translated message for a failed auth call. A message the client does
 * not recognise is shown as the server wrote it, which beats a generic
 * "something went wrong" when someone is reading it out to support.
 */
export function authErrorText(t: TFunction, error: unknown): string {
  if (error instanceof ShareAccountError) {
    if (error.code === "unknown") return error.message;
    return authCodeText(t, error.code, error.retryAfter);
  }
  return error instanceof Error ? error.message : String(error);
}
