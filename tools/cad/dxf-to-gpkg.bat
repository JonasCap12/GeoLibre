@echo off
setlocal enabledelayedexpansion

rem ===================================================================
rem  Chuyen ban ve CAD (DXF/DWG) sang GeoPackage de nap vao GeoLibre.
rem
rem  CACH DUNG
rem    - Keo file .dxf tha vao file .bat nay, HOAC
rem    - dxf-to-gpkg.bat "duong\dan\ban-ve.dxf" [EPSG:xxxx]
rem
rem  VI SAO CAN FILE NAY: xem README.md cung thu muc. Tom tat: ban ve
rem  nang khong doc duoc truc tiep trong trinh duyet, phai dung GDAL
rem  ban native tren may.
rem
rem  Thong bao trong file nay co y khong dau tieng Viet: file .bat chay
rem  duoi nhieu codepage khac nhau tuy may, co dau se thanh ky tu rac.
rem ===================================================================

rem --- He toa do nguon. CAD khong luu CRS nen bat buoc phai khai bao. ---
rem     Mac dinh: VN-2000 / TM-3 107-45 (Lam Dong).
rem     Tinh khac: truyen tham so thu 2, vi du EPSG:5897
set "EPSG=%~2"
if "%EPSG%"=="" set "EPSG=EPSG:5899"

rem --- Tu do QGIS thay vi hard-code, de chay duoc tren may nguoi khac ---
rem Moi thu muc QGIS* duoc duyet rieng: `for /d` bung duoc wildcard, con
rem `for` lop ngoai thi khong. Khong dung %ProgramFiles(x86)% trong khoi
rem ngoac vi dau ")" trong ten bien lam hong cu phap batch.
set "OGR="
for /d %%Q in ("%ProgramFiles%\QGIS*") do (
  if exist "%%~Q\bin\ogr2ogr.exe" (
    set "QGIS=%%~Q"
    set "OGR=%%~Q\bin\ogr2ogr.exe"
  )
)
if "%OGR%"=="" for /d %%Q in ("C:\OSGeo4W*") do (
  if exist "%%~Q\bin\ogr2ogr.exe" (
    set "QGIS=%%~Q"
    set "OGR=%%~Q\bin\ogr2ogr.exe"
  )
)

if "%OGR%"=="" (
  echo [LOI] Khong tim thay ogr2ogr. Can cai QGIS ^(hoac OSGeo4W^).
  echo       Tai tai: https://qgis.org/download/
  echo.
  pause
  exit /b 1
)

rem Chay ogr2ogr truc tiep thi hai bien nay khong duoc dat, GDAL se bao
rem "GDAL_DATA is not defined" va mot so phep chieu se sai.
if exist "%QGIS%\apps\gdal\share\gdal" set "GDAL_DATA=%QGIS%\apps\gdal\share\gdal"
if exist "%QGIS%\share\gdal"           set "GDAL_DATA=%QGIS%\share\gdal"
if exist "%QGIS%\share\proj"           set "PROJ_LIB=%QGIS%\share\proj"
if exist "%QGIS%\apps\proj\share\proj" set "PROJ_LIB=%QGIS%\apps\proj\share\proj"

if "%~1"=="" (
  echo CACH DUNG:
  echo   - Keo file .dxf tha vao file .bat nay
  echo   - Hoac: dxf-to-gpkg.bat "ban-ve.dxf" [EPSG:xxxx]
  echo.
  echo He toa do mac dinh: %EPSG%
  echo.
  pause
  exit /b 1
)

set "SRC=%~1"
set "DST=%~dpn1_WGS84.gpkg"

echo GDAL       : %OGR%
echo File nguon : %SRC%
echo He toa do  : %EPSG%
echo File dich  : %DST%
echo.
echo Dang chuyen doi. Ban ve lon co the mat vai phut...
echo.

if exist "%DST%" del /f /q "%DST%"

rem -skipfailures: ban ve CAD hay co entity loi le te, bo qua tung cai
rem   thay vi hong ca file.
rem OGR_GEOMETRY_ACCEPT_UNCLOSED_RING: HATCH trong CAD thuong co ring
rem   khong khep kin, chap nhan thay vi loai bo.
"%OGR%" -f GPKG "%DST%" "%SRC%" ^
  -s_srs %EPSG% -t_srs EPSG:4326 ^
  -nln entities -nlt GEOMETRY ^
  --config OGR_GEOMETRY_ACCEPT_UNCLOSED_RING YES ^
  -skipfailures

if exist "%DST%" (
  echo.
  echo ============================================================
  echo  XONG: %DST%
  echo.
  echo  Nap vao GeoLibre: Them du lieu -^> Them lop vecto
  echo  O "Source CRS override" de TRONG ^(file da o WGS84^).
  echo  Cot "Layer" giu ten layer CAD goc de loc/to mau.
  echo ============================================================
) else (
  echo.
  echo [LOI] Chuyen doi that bai. Doc thong bao phia tren.
  echo       Neu bao sai he toa do, truyen tham so thu 2, vi du:
  echo       dxf-to-gpkg.bat "ban-ve.dxf" EPSG:5897
)

echo.
pause
