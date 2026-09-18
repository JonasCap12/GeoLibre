# Prompt: Deploy GeoLibre web app lên Cloudflare Pages

> Copy toàn bộ nội dung dưới đây đưa cho AI thực thi. Mọi đường dẫn file và số dòng
> đều đã được kiểm chứng trên repo tại thời điểm viết (commit `bb18f8ab`).

---

## Bối cảnh

Repo là `JonasCap12/GeoLibre` — fork của `opengeos/GeoLibre`, một monorepo npm workspaces
(`apps/*`, `packages/*`, `workers/*`) cộng hai component Python ngoài npm. Cùng một React app
ship ba đường: Tauri desktop, web build (hiện serve bằng nginx trong Docker), và nhúng trong
Jupyter.

Mục tiêu: **host phần web app lên Cloudflare Pages**, giữ các Worker đã có trên Cloudflare, và
để hai backend Python ở nơi khác (chúng không chạy được trên Workers runtime).

Đọc `CLAUDE.md` ở root trước khi làm bất cứ gì — nó là nguồn quy ước của repo.

### Ràng buộc quan trọng nhất về cách thay đổi code

Fork này đồng bộ với upstream bằng **fast-forward merge** (`git merge --ff-only upstream/main`).
Vì vậy: **ưu tiên tuyệt đối việc THÊM FILE MỚI, tránh sửa file upstream đang track.** Mỗi file
upstream bị sửa sẽ làm lần sync sau không còn fast-forward được nữa và biến thành merge có
conflict. Nếu buộc phải sửa một file upstream, phải nêu rõ lý do và liệt kê ra cuối báo cáo.

---

## Phát hiện 1 (BLOCKER) — build mặc định KHÔNG upload lên Cloudflare được

Cloudflare Pages và Workers static assets đều giới hạn **25 MiB cho mỗi file**, và từ chối
thẳng thừng lúc upload chứ không degrade.

`npm run build` emit ra `duckdb-mvp.wasm` (~40 MB) và `duckdb-eh.wasm` (~35 MB) — hai file duy
nhất trong build vượt ngưỡng đó (file lớn kế tiếp chỉ ~22 MB).

**Vì vậy phải build bằng `npm run lite:build`, không phải `npm run build`.**

`npm run lite:build` → `node scripts/lite-build.mjs`, set `GEOLIBRE_DUCKDB_WASM_CDN=1` để
DuckDB-WASM resolve từ jsDelivr thay vì emit ra dist. Output giảm ~251 MB → ~176 MB. Script này
còn có sẵn guard quét toàn bộ dist và fail build nếu còn bất kỳ file nào > 25 MiB.

Bằng chứng trong repo, đọc để tự xác nhận:
- `scripts/lite-build.mjs` (toàn file, đặc biệt `MAX_ASSET_BYTES` và khối guard cuối)
- `apps/geolibre-desktop/vite.config.ts` — khối comment quanh `GEOLIBRE_DUCKDB_WASM_CDN`
  ("this single flag is what decides whether the app can be hosted there at all")
- `workers/viewer/src/index.ts` dòng 1–14 — chính upstream đã từ chối host trên Cloudflare vì
  đúng lý do này và chọn proxy về GitHub Pages

Hệ quả kèm theo:
- **Không được set `GEOLIBRE_NO_EXTERNAL_CDN=1`.** `vite.config.ts` throw error tường minh khi
  kết hợp cờ này với lite build (một bên cấm CDN ngoài, một bên bắt buộc dùng CDN ngoài).
- Lite build **cần mạng ở lần dùng DuckDB đầu tiên** (service worker cache lại sau đó). Sai cho
  triển khai air-gapped — nêu rõ điều này trong tài liệu bàn giao.

---

## Phát hiện 2 — cơ chế runtime config không tồn tại trên Pages

`apps/geolibre-desktop/public/geolibre-runtime-config.js` trong repo chỉ là stub:

```js
window.__GEOLIBRE_DEPLOYMENT_ENV__ = {};
```

Bản Docker **ghi đè file này ở mỗi lần container khởi động** bằng `docker/entrypoint.sh`
(khối `python -c` dài, kết thúc ở đoạn ghi `/usr/share/nginx/html/geolibre-runtime-config.js`).
Nó publish: share URL, collab URL, Clerk/Auth0 keys, embed origins, service catalog, AI route.

Cloudflare Pages **không có bước boot nào** — chỉ là static hosting. Nếu deploy nguyên si, file
sẽ giữ giá trị `{}` và mọi tính năng phụ thuộc nó im lặng tắt.

Chọn MỘT trong hai hướng, và ghi rõ đã chọn hướng nào:

**Hướng A (đơn giản, khuyến nghị):** bake vào bundle lúc build qua biến `VITE_*`. Danh sách biến
có sẵn xem phần `ARG` đầu `Dockerfile` (dòng ~47–87): `VITE_GEOLIBRE_SHARE_URL`,
`VITE_GEOLIBRE_COLLAB_URL`, `VITE_GEOLIBRE_EMBED_ORIGINS`, `VITE_GEOLIBRE_CAPABILITIES`,
`VITE_GEE_OAUTH_CLIENT_ID`, `VITE_MAPILLARY_ACCESS_TOKEN`, `VITE_WELCOME_DISABLED`…
Nhược điểm: đổi cấu hình phải rebuild.

**Hướng B (giữ parity với Docker):** viết script build sinh `geolibre-runtime-config.js` từ biến
môi trường trước khi upload, port lại logic validate từ `docker/entrypoint.sh`. Nhiều việc hơn
nhưng đổi config không cần rebuild.

Lưu ý bảo mật khi làm hướng nào cũng vậy: các giá trị trong file này **công khai với mọi
visitor**. Clerk publishable key (`pk_test_`/`pk_live_`) và Auth0 domain/client ID là public by
design; **không bao giờ** đưa secret key hay client secret vào đây. `entrypoint.sh` có sẵn
validate chặn nhầm lẫn đó — nếu làm hướng B thì port luôn phần validate.

---

## Phát hiện 3 — nginx đang làm 7 việc mà Pages phải thay thế

Đọc `docker/nginx.conf` toàn bộ. Repo **hiện chưa có** `_headers`, `_redirects`, hay
`_routes.json` nào (đã kiểm tra). Phải tạo mới, đặt trong `apps/geolibre-desktop/public/` để
Vite copy thẳng ra gốc `dist/`.

1. **SPA fallback** — `location /` dùng `try_files $uri /index.html`.
   → `_redirects`: `/* /index.html 200`.
   **Nhưng phải loại trừ `/jupyterlite/*`**: nginx cố tình trả 404 ở prefix đó
   (`location ^~ /jupyterlite/` với `try_files $uri $uri/ =404`). Comment trong file giải thích
   đây là bug GeoLibre#1851 — nếu để SPA fallback nuốt, panel Notebook sẽ render một bản sao
   thứ hai của chính GeoLibre thay vì notebook. `/plugins/` cũng `try_files $uri =404`.

2. **CSP cho app** — header dài ở cuối `location /` (dòng ~184). Có 4 placeholder được
   `entrypoint.sh` thay lúc boot: `__GEOLIBRE_COLLAB_CONNECT_SRC__`,
   `__GEOLIBRE_CLERK_SCRIPT_SRC__`, `__GEOLIBRE_CLERK_FRAME_SRC__`, `__GEOLIBRE_AUTH0_FRAME_SRC__`.
   Trong `_headers` phải viết ra **giá trị literal đã resolve** (Pages không substitute gì cả).
   Nếu dùng collab relay thì nhớ thêm origin `wss://…` vào `connect-src` — directive này có bare
   `https:` nhưng **không** có bare `wss:`, thiếu là WebSocket bị chặn im.

3. **PHẢI BỎ phần localhost khỏi CSP.** Bản nginx cho phép `http://localhost:*`,
   `http://127.0.0.1:*`, `ws://localhost:*`, `ws://127.0.0.1:*` trong `connect-src`.
   Cả `docker/nginx.conf` (dòng ~143–148) lẫn `Dockerfile` (dòng ~155–159) đều cảnh báo bằng
   chữ hoa rằng image này dành cho local/single-user, và trên host công khai thì các allowance
   đó cho phép JS được serve đi dò loopback **của từng visitor** (với trình duyệt, localhost là
   máy người dùng, không phải server). Cloudflare Pages là host công khai → **bỏ hết 4 mục này.**

4. **CSP riêng cho `/jupyterlite/*`** — lỏng hơn, có `'unsafe-inline'` trong `script-src`, vì
   JupyterLab bootstrap từ inline `<script>`; dùng policy của app thì site load HTML xong không
   bao giờ boot. Policy này scope riêng prefix đó, app vẫn cấm inline script.

5. **Cache-Control chia ba mức** (đọc các `location` cuối `nginx.conf`):
   - `no-cache, must-revalidate`: `index.html`, `/sw.js`, `/manifest.webmanifest`, `/plugins/*`
   - `public, max-age=31536000, immutable`: asset có content-hash (`.css .js .mjs .wasm .woff2`
     ảnh, font…)
   - `no-store`: `/geolibre-runtime-config.js`
   `/sw.js` **bắt buộc** phải revalidate — nếu rơi vào rule immutable thì service worker cũ bị
   ghim một năm và luồng autoUpdate không bao giờ nhận được redeploy.
   Site JupyterLite cũng cần lặp lại cách chia này (xem `map $uri $geolibre_jupyterlite_cache`
   đầu file): file có hash thì immutable, `service-worker.js`/`lab/bundle.js`/`bootstrap.js` và
   các tên ổn định khác thì phải revalidate.

6. **`/manifest.webmanifest`** cần `Content-Type: application/manifest+json` (mime.types mặc
   định của nginx không có, Pages cũng nên kiểm tra lại).

7. **Header chung**: `X-Content-Type-Options: nosniff` và
   `Referrer-Policy: strict-origin-when-cross-origin` trên mọi response.

Không sửa `docker/nginx.conf` hay `apps/geolibre-desktop/src-tauri/tauri.conf.json` cho việc
này — đó là file upstream, và CSP của Docker/Tauri không liên quan tới deploy Pages.

---

## Phát hiện 4 — hai reverse proxy biến mất trên Pages

**`/sidecar/`** — nginx proxy tới sidecar Python chạy cùng container
(`proxy_pass http://127.0.0.1:8765/`), kèm inject header `X-GeoLibre-Token` bí mật sinh mỗi lần
boot. Trên Pages không có container, không có sidecar.
- Mặc định: **bỏ luôn**. Sidecar vốn optional — Vector tools chạy client-side bằng Turf.js;
  Whitebox/Conversion/Raster tools sẽ báo unavailable. Đây là đường đi được document sẵn.
- Nếu vẫn cần: viết Pages Function `functions/sidecar/[[path]].ts` proxy tới sidecar host ở
  ngoài, giữ token trong secret binding (không bao giờ để lộ ra client). Chú ý sidecar có
  `TrustedHostMiddleware` chỉ chấp nhận Host loopback, và `GEOLIBRE_CONVERSION_ROOTS` giới hạn
  đường dẫn đọc/ghi — deploy ra ngoài loopback phải xem lại cả hai thứ đó.

**`/ai/`** — `entrypoint.sh` sinh location block inject `X-GeoLibre-Instance-Token` phía server.
Trên Pages: trỏ thẳng về Worker `workers/ai-proxy` đã có, nhưng nhớ rằng token phải ở lại phía
server — dùng Pages Function hoặc route của Worker, đừng đưa token vào bundle.

---

## Phát hiện 5 — những gì ĐÃ ở trên Cloudflare, đừng làm lại

| Worker | Vai trò | Domain |
|---|---|---|
| `workers/collab` | Durable Objects + WebSocket Hibernation cho collab realtime | `collab.geolibre.app` |
| `workers/tiles` | Tile proxy + reprojection WMS | `tiles.geolibre.app` |
| `workers/ai-proxy` | Proxy AI có token | (xem `wrangler.jsonc`) |
| `workers/viewer` | Alias cũ, proxy về GitHub Pages | `viewer.geolibre.app` |

Chú ý `workers/tiles/wrangler.toml` set `cpu_ms = 200` và comment ghi rõ knob này **chỉ áp dụng
trên gói trả phí**; free tier cap 10 ms, quá thấp cho reprojection. Chủ repo đang dùng
**Workers Paid** nên phần này ổn, không cần đổi.

`workers/viewer` chỉ là alias legacy proxy về GitHub Pages của upstream — với deploy riêng của
fork này thì nó không liên quan, đừng đụng vào.

Mẫu workflow deploy Cloudflare đã có sẵn trong repo, hãy bám theo đúng khuôn:
`.github/workflows/deploy-tiles.yml` dùng `cloudflare/wrangler-action@v4` với secrets
`CLOUDFLARE_API_TOKEN` và `CLOUDFLARE_ACCOUNT_ID`.

---

## Phát hiện 6 — backend Python KHÔNG lên Cloudflare

- `backend/geolibre_server_api` (FastAPI + SQLAlchemy + psycopg): Workers chạy V8 isolate
  (JS/Wasm); Python Workers còn beta qua Pyodide, không hỗ trợ native extension như psycopg.
- `backend/geolibre_server` (sidecar GDAL/rasterio/Whitebox): cần native binary, một số tool
  (PMTiles/freestiler, whitebox-workflows) chỉ có wheel amd64 — xem khối `TARGETARCH` trong
  `Dockerfile`.

Cả hai ở lại Docker/VPS/PaaS. Việc cần làm phía Pages là **cấu hình cross-origin**, vì frontend
và backend giờ khác domain hoàn toàn (trước đây cùng origin qua nginx):
- Backend: `GEOLIBRE_CORS_ORIGINS` = domain Pages, `GEOLIBRE_PUBLIC_URL`, `GEOLIBRE_VIEWER_URL`.
- Frontend: `GEOLIBRE_SHARE_URL` / `GEOLIBRE_COLLAB_URL` trỏ về domain thật (xem Phát hiện 2).
- `entrypoint.sh` chỉ chấp nhận `https://` cho share URL và `wss://` cho collab URL (plaintext
  chỉ được phép trên loopback) — giữ đúng ràng buộc đó.

---

## Phải TỰ KIỂM CHỨNG, đừng giả định

1. **Giới hạn 20.000 file/deployment của Pages.** Lite build ~176 MB nhưng số *file* mới là thứ
   đáng lo: riêng site JupyterLite đã ~276 file có hash + ~80 file tên cố định (~58 MB theo
   comment trong `nginx.conf`). Sau khi build, chạy đếm file thực tế và báo con số. Nếu vượt:
   hoặc tách JupyterLite ra host riêng, hoặc bỏ nó — nhưng nếu bỏ thì **phải xử lý panel
   Notebook**, vì `Dockerfile` cố tình set `GEOLIBRE_JUPYTERLITE_REQUIRED=1` để thiếu site này
   là fail build, đúng vì bug GeoLibre#1851 ở trên.

2. **Môi trường build.** Build cần Node 22+ **và Python 3.12** (hook `prebuild` của
   `geolibre-desktop` chạy `scripts/build-jupyterlite.mjs`; xem các step trong
   `.github/workflows/web-deploy.yml`). Build image của Cloudflare Pages phải cài được cả hai,
   và `npm ci` cả monorepo thì khá nặng.
   → **Khuyến nghị: build trong GitHub Actions** (copy khuôn `web-deploy.yml`, đổi
   `npm run build -w geolibre-desktop` thành `npm run lite:build`), rồi
   `wrangler pages deploy apps/geolibre-desktop/dist`. Tránh build trực tiếp trên Pages.

3. **`GEOLIBRE_APP_BASE`**: để trống khi serve từ gốc domain. `web-deploy.yml` có comment giải
   thích rõ (bản `/demo/` của `pages.yml` mới cần set).

4. Sau khi deploy, mở app thật bằng trình duyệt và kiểm: map render được, Add Data mở được file
   vector local (đường này đi qua DuckDB từ jsDelivr — chính là thứ lite build vừa đổi), panel
   Notebook ra JupyterLite chứ không phải bản sao GeoLibre, không có CSP violation nào trong
   console. Đừng báo xong khi mới chỉ build pass.

---

## Việc cần làm (đề xuất, được phép điều chỉnh nếu tìm ra cách tốt hơn)

File mới, không đụng file upstream:

1. `apps/geolibre-desktop/public/_headers` — CSP (đã resolve placeholder, đã bỏ localhost),
   Cache-Control ba mức, nosniff, Referrer-Policy, CSP riêng `/jupyterlite/*`.
2. `apps/geolibre-desktop/public/_redirects` — SPA fallback, loại trừ `/jupyterlite/*` và
   `/plugins/*`.
3. `.github/workflows/deploy-cloudflare-pages.yml` — build bằng `npm run lite:build`, deploy
   bằng `wrangler pages deploy`, dùng `CLOUDFLARE_API_TOKEN` + `CLOUDFLARE_ACCOUNT_ID`.
4. (Tùy hướng B) script sinh `geolibre-runtime-config.js` lúc build.
5. (Tùy chọn) `functions/sidecar/[[path]].ts` nếu quyết định giữ sidecar.

Chạy trước khi báo xong: `npm run lint` và `npm run lite:build`. Lưu ý `.pre-commit-config.yaml`
có local hook `npm-build` biên dịch cả app nên rất chậm — scope lại theo file đã đổi:
`pre-commit run --files <paths>`.

Theo quy ước repo (`CLAUDE.md`): **không commit thẳng vào `main`, tạo nhánh và mở PR.**

## Báo cáo lại

Khi xong, báo ngắn gọn: đã tạo/sửa file nào, chọn hướng A hay B cho runtime config, số file
trong `dist` sau lite build so với ngưỡng 20.000, quyết định về sidecar, và mọi file upstream
buộc phải sửa (kèm lý do).
