/**
 * Edit rights of this client in a live collaboration session, read from the
 * store's collaboration state. Moved out of `useCollaboration` so the rules
 * have a test; the hook reads the store and asks these.
 */
import type { CollaborationState } from "@geolibre/core";
import { participantCanEditLayer } from "./collab-protocol";

/** Whether this client may edit the project at all. Not in a session: no. */
export function collaborationCanEdit(c: CollaborationState): boolean {
  if (!c.isActive) return false;
  if (c.role === "host") return true;
  const self = c.participants.find((p) => p.clientId === c.clientId);
  return self?.editOverride ?? c.mode === "co-edit";
}

/**
 * Whether this client may edit one layer. Outside a session every layer is
 * editable; a guest also needs the layer to be unlocked.
 */
export function collaborationCanEditLayer(c: CollaborationState, layerId: string): boolean {
  if (!c.isActive) return true;
  if (c.role === "host") return true;
  const self = c.participants.find((p) => p.clientId === c.clientId);
  if (!self) {
    return c.mode === "co-edit" && !(c.lockedLayerIds ?? []).includes(layerId);
  }
  return participantCanEditLayer(self, c.mode, layerId, c.lockedLayerIds ?? []);
}
