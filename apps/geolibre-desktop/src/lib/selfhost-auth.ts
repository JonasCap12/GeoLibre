import { readDeploymentEnvValue, type EnvRecord } from "./deployment-env";

export const SELFHOST_AUTH_ENV = "VITE_GEOLIBRE_SELFHOST_AUTH";

// Same opt-in spellings as the other deployment flags (see clerk-auth.ts).
// Anything else, including an absent variable, leaves the gate off, so an
// upstream build and every existing deployment stay open.
const ENABLED_VALUES = new Set(["1", "true"]);

/**
 * Whether this deployment signs visitors in against its own accounts API.
 *
 * Absent means disabled. A build-time variable must not gate the desktop or
 * Jupyter builds: those callers pass `webApp: false`, derived from the build
 * target, never from a query parameter a visitor can edit.
 *
 * @param webApp - Whether this is the hosted web build.
 * @param deploymentEnv - Runtime env; defaults to the value on `window`.
 * @param buildEnv - Build-time env; defaults to the allowlisted build env.
 */
export function resolveSelfHostAuth(
  webApp: boolean,
  deploymentEnv?: EnvRecord,
  buildEnv?: EnvRecord,
): boolean {
  if (!webApp) return false;
  const value = readDeploymentEnvValue(SELFHOST_AUTH_ENV, deploymentEnv, buildEnv);
  return ENABLED_VALUES.has(value?.trim().toLowerCase() ?? "");
}
