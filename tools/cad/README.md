# Chuyển bản vẽ CAD sang GeoPackage

`dxf-to-gpkg.bat` — kéo một file `.dxf`/`.dwg` thả vào, nhận lại
`<tên file>_WGS84.gpkg` nạp thẳng được vào GeoLibre.

```
dxf-to-gpkg.bat "ban-ve.dxf"              # mặc định EPSG:5899 (Lâm Đồng)
dxf-to-gpkg.bat "ban-ve.dxf" EPSG:5897    # tỉnh khác
```

Yêu cầu: máy đã cài [QGIS](https://qgis.org/download/) (script tự dò, không cần
cấu hình đường dẫn).

## Tại sao cần công cụ này

GeoLibre **đã đọc được DXF ngay trong trình duyệt** — đó là chức năng
*Thêm dữ liệu → Thêm lớp CAD*. Với bản vẽ gọn nhẹ, dùng thẳng chức năng đó,
không cần script này.

Script tồn tại cho **bản vẽ nặng**, loại mà trình duyệt không kham nổi. Dưới đây
là kết quả điều tra trên một bản vẽ thật (cao tốc Bảo Lộc – Liên Khương, 45,5 MB,
5,2 triệu dòng, 65.381 đối tượng), để người sau khỏi dò lại:

| Nơi chạy | Thư viện | Kết quả |
|---|---|---|
| Trình duyệt | GDAL 3.8.5 (trong DuckDB spatial) | Trả về **0 layer, không báo lỗi** |
| Trình duyệt | gdal3.js (GDAL-WASM) | **Sập runtime WASM** |
| Máy tính | GDAL 3.13 (kèm QGIS) | Chạy 80 giây, ra đủ 65.381 đối tượng |

Hai nguyên nhân chồng lên nhau:

1. **Bug của GDAL 3.8.5.** Section `BLOCKS` của bản vẽ làm driver DXF thất bại
   *im lặng*. Đã cô lập bằng thực nghiệm: bỏ `BLOCKS` thì đọc được, giữ `BLOCKS`
   mà xoá hết entity thì vẫn lỗi. Không nâng cấp được — GDAL nằm cứng trong
   extension spatial của DuckDB, và repo đã dùng bản `duckdb-wasm` mới nhất.
2. **Trần bộ nhớ của WebAssembly.** Khi đọc DXF, GDAL "bung" toàn bộ block
   (inline): mỗi lần chèn block, định nghĩa hình học của nó được nhân bản ra.
   Bản vẽ này có 1,27 triệu dòng định nghĩa block và 9.229 lần chèn, nên phình
   vượt vùng nhớ 32-bit của trình duyệt. GDAL native trên máy không bị giới hạn
   này.

Điểm 2 là **trần của nền tảng, không phải thiếu sót của app** — sửa code
GeoLibre cũng không vượt qua được.

### Cách khác: làm bản vẽ nhẹ đi

Nếu muốn dùng thẳng trong app, bảo bên thiết kế chạy `PURGE` (xoá block không
dùng) rồi xuất lại DXF. Bản vẽ hạ tầng thường mang theo cả thư viện ký hiệu
khổng lồ mà chỉ dùng vài cái — riêng phần `BLOCKS` của file ví dụ đã chiếm
~11 MB trong tổng 45 MB.

## Hệ tọa độ

Bản vẽ CAD **không lưu hệ tọa độ**, nên phải khai báo. Mặc định là
**EPSG:5899** (VN-2000 / TM-3 107-45, kinh tuyến trục 107°45′) dùng cho Lâm Đồng.

Tỉnh khác thì truyền tham số thứ hai. Tra mã EPSG theo kinh tuyến trục của tỉnh
(VN-2000 múi 3°) — ví dụ `EPSG:5897`, `EPSG:5898`.

Nếu nạp lên mà **lệch vài trăm mét**, gần như chắc là sai kinh tuyến trục hoặc
sai phép dịch datum, không phải sai múi. Cách kiểm tra: mở một layer chứa đường
**hiện hữu** (quốc lộ, tỉnh lộ) và so với nền bản đồ — đừng so với tuyến đang thi
công, vì tuyến quy hoạch trên nền OSM cũng chỉ vẽ áng chừng.

## Kết quả đầu ra

- Định dạng GeoPackage, đã chuyển sẵn về WGS84 → nạp vào GeoLibre để trống ô
  *Source CRS override*.
- Giữ cột **`Layer`** mang tên layer CAD gốc, dùng để lọc và tô màu theo hạng mục
  (ví dụ `Taluy 2D cao toc`, `TK-DBO-1920-3D Rãnh dọc`).
- Bản vẽ CAD hay có entity rác ở tọa độ rất xa làm extent trải rộng bất thường;
  nếu bản đồ zoom ra quá xa khi mở lớp, lọc bỏ chúng sau khi nạp.
