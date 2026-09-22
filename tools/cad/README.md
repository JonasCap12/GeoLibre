# Bản vẽ CAD trong GeoLibre

## Dùng thẳng trong app

Mở **Thêm dữ liệu → Thêm lớp CAD**, chọn file `.dxf`, khai hệ tọa độ, xong.

Kể cả bản vẽ nặng. Nếu bộ đọc GDAL có sẵn không đọc nổi file, app tự chuyển
sang bộ đọc DXF viết bằng JavaScript
([`dxf-loader.ts`](../../apps/geolibre-desktop/src/lib/dxf-loader.ts)) và báo
một dòng dưới ô chọn lớp. Khi đó hộp thoại liệt kê **từng layer CAD** thay vì
một lớp `entities` duy nhất — bản vẽ quá nặng thì nạp lần lượt từng layer.

Đo trên bản vẽ thật (cao tốc Bảo Lộc – Liên Khương, 45,5 MB, 5,2 triệu dòng):
đọc hết trong **2,2 giây**, ra 117.200 đối tượng trên 301 layer.

### Vì sao cần bộ đọc thứ hai

GDAL 3.8.5 — bản nằm trong extension spatial của DuckDB-WASM — có lỗi ở driver
DXF: với một số bản vẽ nó thất bại ở section `BLOCKS` và trả về **0 layer mà
không báo lỗi**. Không nâng cấp được, vì GDAL nằm cứng trong extension và repo
đã dùng bản `duckdb-wasm` mới nhất.

| Nơi chạy | Thư viện | Kết quả |
|---|---|---|
| Trình duyệt | GDAL 3.8.5 (DuckDB spatial) | **0 layer, không báo lỗi** |
| Trình duyệt | gdal3.js (GDAL-WASM) | **Sập runtime WASM** |
| Trình duyệt | `dxf-loader.ts` (thuần JS) | 2,2 giây, 117.200 đối tượng |
| Máy tính | GDAL 3.13 (kèm QGIS) | 8,9 giây, 65.381 đối tượng |

Bộ đọc JS đã được đối chiếu với GDAL native trên cùng bản vẽ: các layer nằm ở
model space trùng khớp **chính xác** cả số đối tượng lẫn bounding box (lệch
0,0000). Hai chỗ khác biệt là **cố ý**:

1. **Block được tách thành từng đối tượng.** GDAL gộp mỗi lần chèn block thành
   một feature nhiều phần, và chính cách gộp đó sinh ra `GEOMETRYCOLLECTION` mà
   trình vẽ không giải mã được. Bộ đọc JS chỉ phát ra `LineString`, `Point`,
   `Polygon`.
2. **Tiếng Việt đọc đúng hơn.** Bản vẽ khai `$DWGCODEPAGE = ANSI_1252` nhưng
   `$ACADVER = AC1021` (R2007) nên nội dung thật là UTF-8. GDAL tin vế đầu và
   cho ra `TK-DBO-1920-3D RÃ£nh dá»c`; bộ đọc JS theo vế sau và cho ra
   `TK-DBO-1920-3D Rãnh dọc`.

### Hạn chế đã biết

- **Không vẽ HATCH** (phần tô nền/gạch chéo). Bản vẽ ví dụ có 1.806 đối tượng
  loại này và chúng bị bỏ qua. Nét biên của hạng mục vẫn còn, chỉ mất phần tô.
- **Chỉ 2D.** Cao độ bị bỏ; bản đồ vẽ theo hình chiếu bằng.
- Chỉ áp dụng cho **DXF**. File **DWG** vẫn đi đường GDAL như trước.

## Khi nào dùng script `dxf-to-gpkg.bat`

Script vẫn hữu ích cho ba việc:

- **File DWG** mà GDAL trong trình duyệt không đọc được.
- Cần một file **GeoPackage** để mở bằng QGIS hoặc chia cho người khác, thay vì
  nạp một lần vào app.
- Cần **giữ cả phần HATCH**.

```
dxf-to-gpkg.bat "ban-ve.dxf"              # mặc định EPSG:5899 (Lâm Đồng)
dxf-to-gpkg.bat "ban-ve.dxf" EPSG:5897    # tỉnh khác
```

Yêu cầu: máy đã cài [QGIS](https://qgis.org/download/) (script tự dò đường dẫn).
Kết quả là `<tên file>_WGS84.gpkg`, đã chuyển sẵn về WGS84 → nạp vào GeoLibre để
trống ô *Source CRS override*.

## Hệ tọa độ

Bản vẽ CAD **không lưu hệ tọa độ**, nên luôn phải khai báo. Mặc định là
**EPSG:5899** (VN-2000 / TM-3 107-45, kinh tuyến trục 107°45′) dùng cho Lâm Đồng.
Tỉnh khác thì tra mã EPSG theo kinh tuyến trục của tỉnh (VN-2000 múi 3°) — ví dụ
`EPSG:5897`, `EPSG:5898`.

Nếu nạp lên mà **lệch vài trăm mét**, gần như chắc là sai kinh tuyến trục hoặc
sai phép dịch datum, không phải sai múi. Cách kiểm tra: mở một layer chứa đường
**hiện hữu** (quốc lộ, tỉnh lộ) và so với nền bản đồ — đừng so với tuyến đang thi
công, vì tuyến quy hoạch trên nền OSM cũng chỉ vẽ áng chừng.

## Bản vẽ vẫn quá nặng

Bảo bên thiết kế chạy `PURGE` (xoá block không dùng) rồi xuất lại DXF. Bản vẽ hạ
tầng thường mang theo cả thư viện ký hiệu khổng lồ mà chỉ dùng vài cái — riêng
phần `BLOCKS` của file ví dụ đã chiếm ~11 MB trong tổng 45 MB.

Bản vẽ CAD cũng hay có entity rác ở tọa độ rất xa làm extent trải rộng bất
thường; nếu bản đồ zoom ra quá xa khi mở lớp, lọc bỏ chúng sau khi nạp.
