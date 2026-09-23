# Running independently of the upstream project

By default a GeoLibre build calls servers run by the upstream project. That is
reasonable for the public demo and wrong for a self-hosted deployment: those
servers belong to a Cloudflare account you do not control, they can be turned
off without notice, and five of the routes are origin-gated in a way that will
refuse your traffic the moment you move off a `*.workers.dev` hostname.

This page lists every such dependency and the variable that removes it.

## The variables

Each is a build-time variable. Cloudflare has no container boot step, so
changing one means re-running the web deploy workflow. **Unset means "keep
calling upstream"**, not "feature off" — leaving one blank is a live dependency,
not a disabled feature.

| Variable | Replaces | What breaks if upstream disappears |
| --- | --- | --- |
| `VITE_GEOLIBRE_TILES_URL` | `tiles.geolibre.app` | Planetary basemaps, WMS reprojection, offline basemap extract, OpenAerialMap, OSM/Overpass download, Source.coop, CKAN catalogs, GitHub-raw vector loading |
| `VITE_GEOLIBRE_SHARE_URL` | `share.geolibre.app` | Project sharing and the Project Gallery |
| `VITE_GEOLIBRE_VIEWER_URL` | `web.geolibre.app` | Links produced by HTML export and desktop "Copy link" |
| `VITE_GEOLIBRE_PLUGIN_REGISTRY_URL` | `plugins.geolibre.app` | The plugin registry listing |
| `VITE_LANGUAGE_PACK_BASE_URL` | `languages.geolibre.app` | Downloadable Whitebox translations |
| `VITE_GEOLIBRE_GEOLENS_SERVERS` | `datasets.geolibre.app` | The GeoLens sample-server bookmarks |
| `VITE_GEOLIBRE_COLLAB_URL` | — | Live collaboration (no upstream fallback; unset simply disables it) |

`VITE_GEOLIBRE_GEOLENS_SERVERS` takes `Label|https://host` entries separated by
commas, or the literal `none` to offer no bookmarks at all.

## The one that matters most

`VITE_GEOLIBRE_TILES_URL` moves eight services at once, because they are all
routes on one Worker — `workers/tiles`, which is in this repository. Deploy your
own copy:

```bash
npx wrangler deploy -c workers/tiles/wrangler.selfhost.jsonc
```

It needs no bindings and no secrets; every route proxies a public upstream. The
deploy prints `geolibre-tiles.<subdomain>.workers.dev` — put that in the repo
variable `VITE_GEOLIBRE_TILES_URL` and re-run the web deploy.

Two things to know before you do:

- **The `/wms` route needs a paid Workers plan.** It decodes a PNG, warps it to
  Web Mercator and re-encodes it in pure JS, which is why `wrangler.toml` raises
  `cpu_ms` to 200. The free tier caps CPU at 10 ms whatever the config says, so
  on a free plan expect the Mercury, Venus, Io, Europa, Ganymede and Callisto
  basemaps to time out. Every other route forwards bytes and stays well inside
  10 ms.
- **A custom domain needs an allowlist change.** `isAllowedProxyOrigin` in
  `workers/tiles/src/index.ts` admits only `*.geolibre.app`, `*.workers.dev` and
  localhost. Serving the app from your own domain 403s the OpenAerialMap,
  Overpass, Source.coop, CKAN and GitHub-raw routes until that function also
  names your origin. Once the Worker is yours, that is a change you can make.

## The deploy workflows

`deploy-tiles.yml` and `deploy-collab.yml` are upstream-tracked and run a bare
`wrangler deploy`, which picks up each Worker's `wrangler.toml` and the
`*.geolibre.app` custom domain in it. Only the upstream Cloudflare account can
provision those hostnames, so on a fork both workflows fail every time they run.

`deploy-tiles-selfhost.yml` and `deploy-collab-selfhost.yml` deploy the same two
Workers from their `wrangler.selfhost.jsonc` configs instead.

**Disable the two upstream workflows in the Actions tab** (select the workflow →
`...` → Disable). That is a repository setting rather than a file change, so it
survives every upstream sync without leaving a conflict in a tracked file —
which editing or deleting those files would not.

`deploy-projects-api.yml` and `deploy-web-worker.yml` were written for this fork
and need no replacement.

## How this is kept true

`tests/upstream-independence.test.ts` walks the source tree and fails if a new
`*.geolibre.app` endpoint appears that is neither a documentation link nor a
default with an override variable beside it. It also asserts that all eight
tiles routes still resolve through `tilesUrl()`.

That test exists because this is exactly the kind of property that decays
silently: a new feature, or a merge from upstream, can reintroduce a hardcoded
endpoint that looks fine in review and works fine in testing, right up until the
day the upstream account changes something.
