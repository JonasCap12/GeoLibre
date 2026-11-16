import type { CollaborationApi } from "../../apps/geolibre-desktop/src/hooks/useCollaboration";

/** A transport boundary for component tests; every requested action can be observed. */
export function collaborationApi(overrides: Partial<CollaborationApi> = {}): CollaborationApi {
  return {
    enabled: true,
    canEdit: () => true,
    canEditLayer: () => true,
    start: async () => "ABCD2345",
    join: async () => {},
    leave() {},
    setMode() {},
    setParticipantMode() {},
    mintInvite() {},
    revokeInvite() {},
    setSessionConfig() {},
    setLayerLocks() {},
    kickParticipant() {},
    blockParticipant() {},
    setFollow() {},
    setPresenting() {},
    sendChat: () => true,
    sendCommentMutation: () => true,
    ...overrides,
  };
}
