import { readDeploymentEnvValue } from "./deployment-env";

/**
 * Whether the construction progress screen is offered (fork).
 *
 * Hidden by default: another department builds progress tracking, so this one
 * stays out of the menus to avoid overlapping work. The code, the saved
 * progress data and the screen itself are kept; only the two ways in (the
 * Controls command and a layer's menu item) are gated. Set
 * `VITE_GEOLIBRE_CONSTRUCTION_PROGRESS=1` to offer it again.
 */
export function constructionProgressEnabled(
  read: (key: string) => string | undefined = readDeploymentEnvValue,
): boolean {
  return read("VITE_GEOLIBRE_CONSTRUCTION_PROGRESS") === "1";
}
