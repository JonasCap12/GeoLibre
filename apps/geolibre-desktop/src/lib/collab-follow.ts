import type { CollaborationParticipant, CollaborationRole, MapViewState } from "@geolibre/core";

/** A presence update that may carry the sender's camera. */
export interface FollowablePresence {
  clientId: string;
  view?: MapViewState | null;
}

/**
 * The camera to apply for an inbound presence update.
 * Only the person currently being followed contributes a view; everyone else's
 * presence (and a follow target who has not sent a camera yet) yields null.
 */
export function viewToApply(
  followClientId: string | null,
  message: FollowablePresence,
): MapViewState | null {
  if (!followClientId || message.clientId !== followClientId) return null;
  return message.view ?? null;
}

/**
 * Drop a follow when that person is no longer in the roster.
 * Returns the same id while they are still present.
 */
export function followAfterParticipants(
  followClientId: string | null,
  participants: readonly { clientId: string }[],
): string | null {
  if (!followClientId) return null;
  return participants.some((participant) => participant.clientId === followClientId)
    ? followClientId
    : null;
}

/**
 * The client id to store for a follow request.
 * Following yourself is ignored (`null`); an explicit stop is also `null`.
 */
export function followTarget(clientId: string | null, selfId: string | null): string | null {
  if (!clientId || clientId === selfId) return null;
  return clientId;
}

/** Guests start on the host's camera. Hosts, and a roster with no host, follow nobody. */
export function initialFollowClientId(
  role: CollaborationRole | null,
  participants: readonly CollaborationParticipant[],
  selfId: string | null,
): string | null {
  if (role !== "guest") return null;
  const host = participants.find(
    (participant) => participant.role === "host" && participant.clientId !== selfId,
  );
  return host?.clientId ?? null;
}

/**
 * Decide who to follow when a `welcome` arrives.
 * The first welcome of a guest session follows the host. Later welcomes (a
 * transparent reconnect) keep the person's current choice, including "nobody",
 * and only clear it when that person has left the roster.
 */
export function followOnWelcome(input: {
  role: CollaborationRole;
  selfId: string;
  participants: readonly CollaborationParticipant[];
  currentFollow: string | null;
  autoFollowHost: boolean;
}): { followClientId: string | null; autoFollowHost: boolean } {
  if (input.autoFollowHost && input.role === "guest") {
    return {
      followClientId: initialFollowClientId("guest", input.participants, input.selfId),
      autoFollowHost: false,
    };
  }
  return {
    followClientId: followAfterParticipants(input.currentFollow, input.participants),
    autoFollowHost: input.autoFollowHost,
  };
}
