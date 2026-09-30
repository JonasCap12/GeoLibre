import { getBuildEnvironment } from "@geolibre/core";
import { AUTH0_CLIENT_ID_ENV, AUTH0_DOMAIN_ENV, resolveAuth0Config } from "./auth0-auth";
import {
  CLERK_PUBLISHABLE_KEY_ENV,
  resolveClerkPublishableKey,
  resolveClerkWaitlistEnabled,
} from "./clerk-auth";
import { readDeploymentEnv, readDeploymentEnvValue, type EnvRecord } from "./deployment-env";
import { SELFHOST_AUTH_ENV, resolveSelfHostAuth } from "./selfhost-auth";

/** Which optional sign-in gate a hosted deployment has configured, if any. */
export type AuthGateConfig =
  | { provider: "clerk"; publishableKey: string; waitlist: boolean }
  | { provider: "auth0"; domain: string; clientId: string }
  | { provider: "selfhost" };

/**
 * Pick the sign-in gate for a web deployment.
 *
 * Clerk, Auth0 and this deployment's own accounts are configured independently
 * and only one is ever loaded, so a deployment that names more than one needs
 * a rule. It is the same rule the individual settings already follow (see
 * deployment-env.ts): the deployment env is the more specific statement, so a
 * provider named there wins over one baked into the build. Naming several at
 * the same level keeps the one that shipped first — Clerk, then Auth0, then
 * self-host. Self-host is last on purpose: turning it on next to an existing
 * Clerk or Auth0 configuration must not silently replace that gate. An image
 * built with a Clerk key must not switch providers on its own. The Docker
 * entrypoint refuses to boot when both Clerk and Auth0 are passed at runtime,
 * so that tie only arises from build-time environment variables.
 *
 * @param webApp - Whether this is the hosted web build. Must be derived from
 *   the build target alone: a runtime signal the visitor controls (`?embed=1`)
 *   would let anyone switch a configured gate off.
 * @param deploymentEnv - Runtime env; defaults to the value on `window`.
 * @param buildEnv - Build-time env; defaults to the allowlisted build env.
 * @returns The provider and its settings, or undefined when no gate is configured.
 */
export function resolveAuthGate(
  webApp: boolean,
  deploymentEnv?: EnvRecord,
  buildEnv?: EnvRecord,
): AuthGateConfig | undefined {
  if (!webApp) return undefined;
  const deployment = deploymentEnv ?? readDeploymentEnv();
  const build = buildEnv ?? (getBuildEnvironment() as EnvRecord);

  const clerkKey = resolveClerkPublishableKey(true, deployment, build);
  const auth0 = resolveAuth0Config(true, deployment, build);
  const selfhost = resolveSelfHostAuth(true, deployment, build);

  const clerk = (): AuthGateConfig => ({
    provider: "clerk",
    publishableKey: clerkKey!,
    // Resolved across both tiers rather than the winning one, so a build-time
    // key can still have its waitlist screen turned on at runtime.
    waitlist: resolveClerkWaitlistEnabled(true, deployment, build),
  });

  // Raw presence, not a full resolve: this only asks which tier *named* the
  // provider. Re-resolving would re-report a partial Auth0 configuration that
  // the merged read above already completed from the build env.
  const clerkNamedAtRuntime = Boolean(
    readDeploymentEnvValue(CLERK_PUBLISHABLE_KEY_ENV, deployment, {}),
  );
  // Either half counts: the pair can be split across the two tiers, so a
  // deployment that supplies only the client ID at runtime has still named
  // Auth0 there, and checking the domain alone would hand it back to Clerk.
  const auth0NamedAtRuntime =
    Boolean(readDeploymentEnvValue(AUTH0_DOMAIN_ENV, deployment, {})) ||
    Boolean(readDeploymentEnvValue(AUTH0_CLIENT_ID_ENV, deployment, {}));
  const selfhostNamedAtRuntime = Boolean(readDeploymentEnvValue(SELFHOST_AUTH_ENV, deployment, {}));

  // Deployment (20) beats build (10). The remainder is the same-tier order
  // documented above: Clerk, then Auth0, then self-host. An unconfigured
  // provider scores below zero and cannot win.
  const score = (configured: boolean, namedAtRuntime: boolean, tie: number) =>
    configured ? (namedAtRuntime ? 20 : 10) + tie : -1;
  const clerkScore = score(Boolean(clerkKey), clerkNamedAtRuntime, 3);
  const auth0Score = score(Boolean(auth0), auth0NamedAtRuntime, 2);
  const selfhostScore = score(selfhost, selfhostNamedAtRuntime, 1);
  const best = Math.max(clerkScore, auth0Score, selfhostScore);
  if (best < 0) return undefined;
  if (clerkScore === best) return clerk();
  if (auth0Score === best && auth0) return { provider: "auth0", ...auth0 };
  return { provider: "selfhost" };
}
