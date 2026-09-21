// Header control for the JupyterLite prefix, and nothing else.
//
// Only /jupyterlite/* reaches this Worker (assets.run_worker_first in
// wrangler.jsonc). Every other request is answered by the asset server with no
// Worker invocation at all, so the app keeps the zero-CPU serving path.
//
// It exists because _headers cannot express this. When several _headers rules
// match one request, Cloudflare APPENDS their values into a single header rather
// than letting the more specific rule win. For Content-Security-Policy that is
// not a cosmetic difference: a comma-joined CSP is enforced as multiple
// policies, and the browser applies their intersection. So a /jupyterlite/*
// block granting 'unsafe-inline' did not replace the app policy from /* — it sat
// beside it, and the app policy (which deliberately forbids inline script) went
// on blocking JupyterLab's inline bootstrap. The symptom is the one
// docker/nginx.conf documents: the site loads its HTML and then never boots, no
// shell, no launcher, one CSP violation and nothing else (GeoLibre#1851).
//
// Setting the header here replaces the value outright, so exactly one policy
// reaches the browser.

// The app policy minus the Google/ArcGIS origins this site does not use, plus
// the 'unsafe-inline' script-src JupyterLab's bootstrap requires. Kept in sync
// with the /jupyterlite/ location in docker/nginx.conf, which serves the same
// site behind nginx.
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

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const response = await env.ASSETS.fetch(request);

    // Every header this prefix needs is set explicitly rather than inherited
    // from the _headers rules, so the result does not depend on whether those
    // rules ran before the response reached this Worker.
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
  },
};
