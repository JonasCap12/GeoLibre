/** A browser and OS name pulled from a User-Agent header, for the device lists. */
export interface DeviceSummary {
  browser: string;
  os: string;
}

// Order matters: Edge and Opera also send "Chrome/", and Chrome also sends
// "Safari/", so the more specific tokens are tried first.
const BROWSERS: ReadonlyArray<[RegExp, string]> = [
  [/\bEdg(?:e|A|iOS)?\/(\d+)/, "Edge"],
  [/\bOPR\/(\d+)/, "Opera"],
  [/\bFirefox\/(\d+)/, "Firefox"],
  [/\bFxiOS\/(\d+)/, "Firefox"],
  [/\bCriOS\/(\d+)/, "Chrome"],
  [/\bChrome\/(\d+)/, "Chrome"],
  [/\bVersion\/(\d+)[\d.]* (?:Mobile\/\S+ )?Safari\//, "Safari"],
];

const SYSTEMS: ReadonlyArray<[RegExp, string]> = [
  [/\b(?:iPhone|iPad|iPod)\b/, "iOS"],
  [/\bAndroid\b/, "Android"],
  [/\bWindows\b/, "Windows"],
  [/\bMac OS X\b|\bMacintosh\b/, "macOS"],
  [/\bCrOS\b/, "ChromeOS"],
  [/\bLinux\b/, "Linux"],
];

/**
 * Names the browser and OS in a User-Agent string, or returns null when either
 * is unrecognised so the caller can show the raw header instead of guessing.
 */
export function describeUserAgent(userAgent: string | null | undefined): DeviceSummary | null {
  if (!userAgent) return null;
  let browser: string | null = null;
  for (const [pattern, name] of BROWSERS) {
    const match = pattern.exec(userAgent);
    if (match) {
      browser = `${name} ${match[1]}`;
      break;
    }
  }
  const os = SYSTEMS.find(([pattern]) => pattern.test(userAgent))?.[1] ?? null;
  return browser && os ? { browser, os } : null;
}
