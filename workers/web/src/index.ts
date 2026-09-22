// Serving rules the asset server cannot express on its own: the JupyterLite
// prefix's headers, and what a request that matches no asset should get.
//
// `assets.not_found_handling` is "none" in wrangler.jsonc, so a request that
// matches no asset arrives here instead of being answered by the asset server.
// That is the only way to decide per path between a real 404 and the
// single-page-application fallback, and both are needed:
//
//   - A missing hashed chunk under /assets/ MUST 404. Answering it with
//     index.html returns "200 OK, text/html" for a URL the browser asked for as
//     JavaScript, and _headers marks /assets/* `immutable`, so the browser then
//     caches "this chunk is HTML" for a year with no revalidation. A tab that
//     requests a chunk mid-deploy would stay broken until its cache is cleared
//     by hand. A 404 is not cached that way, and the stale-chunk reload guard
//     (installStaleChunkReload) recovers from it.
//   - /jupyterlite/ and /plugins/ MUST 404 rather than fall back, which is what
//     docker/nginx.conf does with `=404`. Answering a missing
//     /jupyterlite/lab/index.html with the app is what made the Notebook panel
//     render a second copy of GeoLibre instead of a notebook (GeoLibre#1851).
//   - Everything else still needs the fallback, replacing nginx's
//     `try_files $uri /index.html`.

/** Prefixes that are real directories of files; a miss there is a 404. */
const NEVER_FALLBACK = ["/assets/", "/jupyterlite/", "/plugins/"];

/**
 * True when the path names a file rather than an app route.
 *
 * Anything with an extension was requested as a file — a script, an image, a
 * manifest — and answering it with HTML cannot be what the caller wanted. The
 * app's own entry points (`/`, `/?project=…`) carry no extension, so this
 * cannot swallow a real route.
 */
function looksLikeFile(pathname: string): boolean {
  const lastSegment = pathname.slice(pathname.lastIndexOf("/") + 1);
  return lastSegment.includes(".");
}

/** A 404 that is never cached, so the path recovers as soon as it exists. */
function notFound(): Response {
  return new Response("Not found", {
    status: 404,
    headers: {
      "Content-Type": "text/plain; charset=utf-8",
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
    },
  });
}

// The app policy minus the Google/ArcGIS origins this site does not use, plus
// the 'unsafe-inline' script-src JupyterLab's bootstrap requires. Kept in sync
// with the /jupyterlite/ location in docker/nginx.conf, which serves the same
// site behind nginx.
//
// It is set here because _headers cannot express it. When several _headers rules
// match one request, Cloudflare APPENDS their values into a single header rather
// than letting the more specific rule win. For Content-Security-Policy that is
// not cosmetic: a comma-joined CSP is enforced as multiple policies and the
// browser applies their intersection, so a /jupyterlite/* block granting
// 'unsafe-inline' did not replace the app policy from /* — it sat beside it, and
// the app policy (which deliberately forbids inline script) went on blocking
// JupyterLab's bootstrap. Setting the header here replaces the value outright,
// so exactly one policy reaches the browser.
const JUPYTERLITE_CSP =
  "default-src 'self'; " +
  "connect-src 'self' https: data: blob:; " +
  "img-src 'self' data: blob: https:; " +
  "media-src 'self' blob: https:; " +
  "style-src 'self' 'unsafe-inline'; " +
  "script-src 'self' 'unsafe-inline' blob: 'unsafe-eval' 'wasm-unsafe-eval' " +
  "https://cdn.jsdelivr.net/npm/ https://cdn.jsdelivr.net/pyodide/ " +
  "https://api.mapbox.com/mapbox-gl-js/; " +
  "worker-src blob: 'self'";

interface Env {
  ASSETS: Fetcher;
}

/** Serve a JupyterLite asset with the policy that site needs. */
async function serveJupyterLite(request: Request, env: Env): Promise<Response> {
  const response = await env.ASSETS.fetch(request);
  if (response.status === 404) return notFound();

  // Every header this prefix needs is set explicitly rather than inherited from
  // the _headers rules, so the result does not depend on whether those rules ran
  // before the response reached this Worker.
  const headers = new Headers(response.headers);
  headers.set("Content-Security-Policy", JUPYTERLITE_CSP);
  headers.set("X-Content-Type-Options", "nosniff");
  headers.set("Referrer-Policy", "strict-origin-when-cross-origin");
  // Unlike nginx.conf, this does not split the prefix into immutable hashed
  // assets and revalidating stable ones. Everything under it revalidates: that
  // costs conditional requests when the Notebook panel opens (the edge cache
  // still serves the bodies), and it can never strand a stale JupyterLite
  // service worker, which is the failure worth avoiding.
  headers.set("Cache-Control", "no-cache, must-revalidate");

  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    // run_worker_first routes this prefix here whether or not the asset exists.
    if (url.pathname.startsWith("/jupyterlite/")) {
      return serveJupyterLite(request, env);
    }

    // Past this point the asset server already looked and found nothing.
    if (NEVER_FALLBACK.some((prefix) => url.pathname.startsWith(prefix))) return notFound();
    if (looksLikeFile(url.pathname)) return notFound();

    // A GET-only fallback: answering POST/PUT to an unknown path with the app
    // shell would turn a wrong method into a misleading 200.
    if (request.method !== "GET" && request.method !== "HEAD") return notFound();

    const index = await env.ASSETS.fetch(new URL("/index.html", url));
    // The app shell is served for a path that is not `/`, so its own _headers
    // rule (revalidate, never immutable) is the right one to keep.
    return new Response(index.body, {
      status: index.status === 404 ? 404 : 200,
      headers: index.headers,
    });
  },
};
