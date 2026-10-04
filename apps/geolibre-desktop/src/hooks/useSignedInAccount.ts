import { useEffect, useState } from "react";
import { fetchAccount, type AccountInfo } from "../lib/share-account";
import { resolveShareBaseUrl } from "../lib/share-geolibre";
import { useDesktopSettingsStore } from "./useDesktopSettings";

// One request per token for the whole app: the account menu and the
// collaboration dialog both ask, and neither should wait on the other.
const cache = new Map<string, Promise<AccountInfo | null>>();

function load(token: string): Promise<AccountInfo | null> {
  let pending = cache.get(token);
  if (pending === undefined) {
    pending = fetchAccount({ token }).catch(() => {
      // Forget a failure so the next mount retries; a 401 is handled by the
      // session watch, which clears the token.
      cache.delete(token);
      return null;
    });
    cache.set(token, pending);
  }
  return pending;
}

/**
 * The account the saved share token belongs to, or null when nobody is signed
 * in to this deployment's projects server (desktop and ungated builds, or a
 * deployment without one).
 */
export function useSignedInAccount(): { account: AccountInfo | null; loading: boolean } {
  const token = useDesktopSettingsStore((s) => s.desktopSettings.shareToken.trim());
  const usable = token !== "" && resolveShareBaseUrl() !== null;
  const [state, setState] = useState<{ token: string; account: AccountInfo | null } | null>(null);

  useEffect(() => {
    if (!usable) return;
    let cancelled = false;
    void load(token).then((account) => {
      if (!cancelled) setState({ token, account });
    });
    return () => {
      cancelled = true;
    };
  }, [token, usable]);

  if (!usable) return { account: null, loading: false };
  if (state === null || state.token !== token) return { account: null, loading: true };
  return { account: state.account, loading: false };
}
