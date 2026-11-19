/**
 * Whether the road network dashboard is open. A tiny external store, like
 * `progress-screen.ts`: the menu and the command palette open it, and the
 * screen component (mounted beside the shell in `App`) subscribes.
 *
 * While open, `data-network-dashboard` on the document element lets
 * `index.css` pin the map area into the dashboard's map cell.
 */

/** Document-element attribute the dashboard CSS keys on. */
export const NETWORK_DASHBOARD_ATTRIBUTE = "data-network-dashboard";

let open = false;
const listeners = new Set<() => void>();

function emit(): void {
  for (const listener of [...listeners]) listener();
}

export function openNetworkDashboard(): void {
  if (open) return;
  open = true;
  emit();
}

export function closeNetworkDashboard(): void {
  if (!open) return;
  open = false;
  emit();
}

export function isNetworkDashboardOpen(): boolean {
  return open;
}

export function subscribeNetworkDashboard(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}
