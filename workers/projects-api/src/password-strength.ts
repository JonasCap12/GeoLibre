// Password rules and strength estimate, shared by the projects API and the app.
//
// TWO IDENTICAL COPIES: workers/projects-api/src/password-strength.ts and
// apps/geolibre-desktop/src/lib/password-strength.ts. The server enforces these
// rules and the app shows them live while someone types, so they must agree to
// the byte; tests/password-strength.test.ts fails when the copies differ. Edit
// one, then copy it over the other.
//
// The policy follows OWASP ASVS 5.0 V6.2 and NIST SP 800-63B-4:
// - at least 8 characters (ASVS 6.2.1), and up to 1024 so passphrases and
//   password managers are never cut short;
// - no composition rules (no "must contain a symbol"), which push people to
//   predictable `Matkhau@123` shapes;
// - refuse what an attacker tries first instead: the account's own name, the
//   most common passwords and their decorated forms, and keyboard, sequence and
//   repetition patterns; the server also asks Have I Been Pwned (hibp.ts);
// - and require a minimum estimated strength, so a short password has to be
//   less predictable than a long one, while a long passphrase of plain words
//   passes without symbols.
//
// Pure and dependency-free: it runs in workerd, in the browser and under
// `node --test` alike.

export const MIN_PASSWORD_LENGTH = 8;
export const MAX_PASSWORD_LENGTH = 1024;

/** 0 very weak, 1 weak, 2 fair, 3 strong, 4 very strong. */
export type PasswordScore = 0 | 1 | 2 | 3 | 4;

/** The lowest score a new password may have. */
export const MIN_PASSWORD_SCORE: PasswordScore = 2;

/** Words a password must not contain, beyond the common list below. */
export interface PasswordContext {
  username?: string | null;
  email?: string | null;
}

export interface PasswordCheck {
  /** Estimated strength; 0 whenever a pattern or personal rule fails. */
  score: PasswordScore;
  /** At least MIN_PASSWORD_LENGTH characters. */
  longEnough: boolean;
  /** Over MAX_PASSWORD_LENGTH characters. */
  tooLong: boolean;
  /** Free of the username, the email's name part and the product name. */
  notPersonal: boolean;
  /** Not a common password, a repetition, a sequence or a keyboard run. */
  notPredictable: boolean;
  /** Score at least MIN_PASSWORD_SCORE. */
  strongEnough: boolean;
  /** Every rule above passes. */
  ok: boolean;
}

/** Why a password is refused, in the order the rules are checked. */
export type PasswordProblem = "too-short" | "too-long" | "context" | "common" | "weak";

// Context words shorter than this are skipped: a three-letter username would
// otherwise reject every passphrase that happens to contain it.
const MIN_CONTEXT_WORD = 4;

/**
 * Bases that are refused however they are decorated (`Password123!`,
 * `matkhau@2026`): the start of every guessing list, plus the Vietnamese ones
 * this team is most likely to reach for. Compared after the letters are
 * separated from digits and symbols and lower-cased.
 */
const COMMON_BASES = new Set([
  "password",
  "passw",
  "pass",
  "admin",
  "administrator",
  "welcome",
  "letmein",
  "iloveyou",
  "qwerty",
  "qwertyuiop",
  "asdfgh",
  "abc",
  "abcd",
  "abcdef",
  "login",
  "hello",
  "master",
  "monkey",
  "dragon",
  "football",
  "baseball",
  "sunshine",
  "princess",
  "superman",
  "batman",
  "trustno",
  "secret",
  "changeme",
  "default",
  "user",
  "test",
  "guest",
  "root",
  "matkhau",
  "mk",
  "anhyeuem",
  "emyeuanh",
  "yeuem",
  "vietnam",
  "hanoi",
  "saigon",
  "hochiminh",
  "geolibre",
]);

/** Keyboard rows, forwards; the reverse direction is checked too. */
const KEYBOARD_ROWS = [
  "`1234567890-=",
  "qwertyuiop[]\\",
  "asdfghjkl;'",
  "zxcvbnm,./",
  "~!@#$%^&*()_+",
  "1qaz2wsx3edc4rfv5tgb6yhn7ujm8ik9ol0p",
];

function contextWords(context: PasswordContext): string[] {
  const words = ["geolibre"];
  if (context.username) words.push(context.username.toLowerCase());
  const local = context.email?.split("@")[0]?.toLowerCase();
  if (local) words.push(local);
  return words.filter((word) => word.length >= MIN_CONTEXT_WORD);
}

/** True when every step between neighbours is the same +1 or -1. */
function isSequence(chars: string[]): boolean {
  if (chars.length < 3) return false;
  const step = chars[1].codePointAt(0)! - chars[0].codePointAt(0)!;
  if (step !== 1 && step !== -1) return false;
  for (let index = 2; index < chars.length; index += 1) {
    if (chars[index].codePointAt(0)! - chars[index - 1].codePointAt(0)! !== step) return false;
  }
  return true;
}

function isKeyboardRun(lowered: string): boolean {
  if (lowered.length < 4) return false;
  return KEYBOARD_ROWS.some((row) => {
    const reversed = Array.from(row).reverse().join("");
    return row.includes(lowered) || reversed.includes(lowered);
  });
}

/**
 * Whether the password is one of the shapes guessed first: few distinct
 * characters, a straight sequence, a keyboard run, or a common base word with
 * digits and symbols around it.
 */
function isPredictable(password: string): boolean {
  const lowered = password.toLowerCase();
  const chars = Array.from(lowered);
  if (new Set(chars).size < 3) return true;
  if (isSequence(chars) || isKeyboardRun(lowered)) return true;
  // `Password123!` → ["password"]; `hello2026` → ["hello"]. A password that is
  // nothing but common bases and decoration is refused.
  const words = lowered.split(/[^\p{L}]+/u).filter((word) => word !== "");
  if (words.length > 0 && words.every((word) => COMMON_BASES.has(word))) return true;
  // All digits or all symbols that are a sequence or a run of one block
  // (`12341234`, `11223344`) are caught by the distinct-character and score
  // rules; a date such as `20261004` is caught by the score.
  return false;
}

/**
 * The search space an attacker would have to cover, in bits: length times
 * the bits per character of the character classes used, with repeated and
 * sequential characters counting for little, since guessers try those first.
 */
export function passwordBits(password: string): number {
  const chars = Array.from(password);
  if (chars.length === 0) return 0;
  let pool = 0;
  if (/[a-z]/.test(password)) pool += 26;
  if (/[A-Z]/.test(password)) pool += 26;
  if (/[0-9]/.test(password)) pool += 10;
  if (/[^A-Za-z0-9\p{L}]/u.test(password)) pool += 33;
  if (/[^\p{ASCII}]/u.test(password) && /\p{L}/u.test(password)) pool += 40;
  let effective = 0;
  for (let index = 0; index < chars.length; index += 1) {
    if (index === 0) {
      effective += 1;
      continue;
    }
    const step = chars[index].codePointAt(0)! - chars[index - 1].codePointAt(0)!;
    effective += step === 0 || step === 1 || step === -1 ? 0.25 : 1;
  }
  // Heavy reuse of a few characters (`abababab`) is cheaper to guess than its
  // length suggests.
  const distinct = new Set(chars).size;
  const reuse = Math.min(1, distinct / Math.max(1, chars.length / 2));
  return effective * reuse * Math.log2(Math.max(pool, 2));
}

/** Bits to score. Fair (2) starts where 8 random lowercase letters land. */
export function scoreFromBits(bits: number): PasswordScore {
  if (bits < 28) return 0;
  if (bits < 36) return 1;
  if (bits < 50) return 2;
  if (bits < 70) return 3;
  return 4;
}

/** Every rule at once, for both the server's verdict and the live checklist. */
export function checkPassword(password: string, context: PasswordContext = {}): PasswordCheck {
  const length = Array.from(password).length;
  const longEnough = length >= MIN_PASSWORD_LENGTH;
  const tooLong = password.length > MAX_PASSWORD_LENGTH;
  const lowered = password.toLowerCase();
  const notPersonal = !contextWords(context).some((word) => lowered.includes(word));
  const notPredictable = password === "" ? true : !isPredictable(password);
  let score = scoreFromBits(passwordBits(password));
  if (!notPredictable || !notPersonal) score = 0;
  const strongEnough = score >= MIN_PASSWORD_SCORE;
  return {
    score,
    longEnough,
    tooLong,
    notPersonal,
    notPredictable,
    strongEnough,
    ok: longEnough && !tooLong && notPersonal && notPredictable && strongEnough,
  };
}

/** The first rule a password breaks, or null when it may be used. */
export function passwordProblem(
  password: string,
  context: PasswordContext = {},
): PasswordProblem | null {
  const check = checkPassword(password, context);
  if (check.tooLong) return "too-long";
  if (!check.longEnough) return "too-short";
  if (!check.notPersonal) return "context";
  if (!check.notPredictable) return "common";
  if (!check.strongEnough) return "weak";
  return null;
}
