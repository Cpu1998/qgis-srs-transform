# qgis-srs-transform

基于 QGIS [srs.db](https://github.com/qgis/QGIS/blob/master/resources/srs.db) 的前端坐标转换 TypeScript 库。
输入「坐标 + 源坐标系 + 目标坐标系」，输出目标坐标系下的坐标值。

- **数据全部来自 srs.db**（13,326 条坐标系定义）：浏览器端用 [sql.js](https://sql.js.org)（WASM 版 SQLite）直接读取 `tbl_srs` 的 PROJ 定义；
- **投影计算**用 [proj4js](https://proj4js.org)；
- **基准转换**（北京54 / 西安80 / Pulkovo 等非 WGS84 基准 → WGS84）自动注入 `tbl_datum_transform` 中的 EPSG Helmert 参数，不注入时此类转换会偏差 50~200 米。

## 安装 / 目录

本目录即一个完整的 npm 包工程：

```
src/           库源码（TypeScript）
  index.ts       入口与导出
  service.ts     SrsService 门面（transform / search / inspect…）
  transform.ts   投影换算核心 + 基准转换注入
  srs-db.ts      tbl_srs / tbl_datum_transform 查询层
  loader.ts      sql.js 加载（URL / 字节 / 已打开的 Database）
  sql-js.d.ts    sql.js 类型补丁
test/          Node 测试（npm test，41 项断言）
demo/          浏览器演示页（npm run demo）
srs.db         QGIS 坐标系数据库（数据文件，随应用部署）
```

依赖：`proj4`、`sql.js`。构建：`npm run build`（输出 `dist/`，ESM + d.ts）。

## 快速开始

### 浏览器

```ts
import { SrsService } from 'qgis-srs-transform';

const srs = await SrsService.create({ dbUrl: 'assets/srs.db' });

// 输入坐标 + 源坐标系 + 目标坐标系 → 输出目标坐标系坐标
const out = srs.transform([116.3913, 39.9075], 'EPSG:4326', 'EPSG:3857');
// [12956620.248767143, 4852509.522163174]

// 北京54 高斯克吕格 → WGS84 经纬度（自动应用 EPSG:15921 三参数基准转换）
const [lon, lat] = srs.transform([500000, 4429607.37], 'EPSG:2435', 'EPSG:4326');
// [114.000566…, 40.000309…]
```

> sql.js 需要下载 `sql-wasm.wasm`。默认从页面同目录加载；bundler 场景请用 `locateFile` 指定，
> Vite 示例：`import wasmUrl from 'sql.js/dist/sql-wasm.wasm?url'` 然后
> `SrsService.create({ dbUrl: 'assets/srs.db', locateFile: () => wasmUrl })`。
> 注意部分打包器会走 sql.js 的 browser 分支、请求的文件名为 `sql-wasm-browser.wasm`，两个名字都需可访问。

### Node（≥18）

```ts
import { readFileSync } from 'node:fs';
import { SrsService } from 'qgis-srs-transform';

const srs = await SrsService.create({ dbData: readFileSync('srs.db') });
srs.transform([500000, 4429529.03], 'EPSG:4547', 'EPSG:4326'); // → [114, 40]
```

### 在 Cesium 中使用

目标为 WGS84 时可直接得到 Cesium 友好的经纬度（度）：

```ts
const c = srs.toCesiumDegrees([500000, 4429607.37], 'EPSG:2435');
// { longitude: 114.000566…, latitude: 40.000309…, height: 0 }

const position = Cesium.Cartesian3.fromDegrees(c.longitude, c.latitude, c.height);
// 或 Cesium.Cartographic.fromDegrees(c.longitude, c.latitude, c.height)
```

任何坐标系互转（如 西安80 → Web Mercator）直接：

```ts
const xy = srs.transform([500000, 4350000], 'EPSG:2384', 'EPSG:3857');
```

## API

`SrsService.create(source: SrsSource): Promise<SrsService>`

`SrsSource`（三选一）：`dbUrl`（fetch 下载）、`dbData`（内存字节）、`database`（已打开的 sql.js Database，`close()` 不会关闭它）；可选 `locateFile`、`sqlJsInit`。

| 方法 | 说明 |
| --- | --- |
| `transform(coord, from, to, opts?)` | 正向转换。`coord` 支持 `[x,y]`、`[x,y,z]`、`{x,y,z?}`，输出保持同形状 |
| `transformInverse(coord, from, to, opts?)` | 反向（`to` → `from`） |
| `transformBatch(coords[], from, to, opts?)` | 批量转换（复用缓存的转换器） |
| `toWgs84(coord, from, opts?)` / `fromWgs84(coord, to, opts?)` | 与 WGS84 经纬度互转的快捷方法 |
| `toCesiumDegrees(coord, from, opts?)` | 输出 `{longitude, latitude, height}`（度），直接喂给 Cesium |
| `describe(ref)` | 返回 `SrsRecord`（描述、PROJ 串、是否地理坐标系等），未知则抛错 |
| `search(text, opts?)` | 按名称模糊搜索坐标系，EPSG 优先，默认排除已废弃项 |
| `inspect(from, to, opts?)` | 查看实际执行的定义：生效 PROJ 串、注入的基准转换操作 |
| `close()` | 释放内存数据库 |

**坐标系引用 `CrsRef`**：`4326`（数字，默认 EPSG）、`'EPSG:4326'` / `'ESRI:54009'`（auth:id）、`{auth:'EPSG', id:4326}`，也支持完整描述名 `'WGS 84 / UTM zone 50N'`。

**`opts.datumShift`**（基准转换策略，默认 `'auto'`）：

- `'auto'`：PROJ 串中无 `+towgs84/+datum/+nadgrids` 时，查 `tbl_datum_transform` 取该基准的首选 EPSG 操作注入（9603 三参直接用；9606 七参按 proj4 的 position-vector 约定取反旋转角符号；9615 网格转换跳过）；
- `'none'`：完全按 PROJ 串计算（无基准改正）；
- `15921`：指定某个 `coord_op_code`；
- `[dx,dy,dz]` / 7 元素数组：显式 `+towgs84` 参数。

## 约定

- 地理坐标系输入/输出单位为**度**，顺序 **x = 经度在前**（proj4 惯例，非 EPSG 官方轴序）；
- `z`（高程）原样传递，不参与投影改正；
- 转换路径为 源 → WGS84 → 目标（proj4 枢纽模式），转换器按「坐标系对」缓存。

## 局限性

- 计算引擎为 proj4js：本库验证过 EPSG 全部水平坐标系中约 99% 可解析；不支持 NTv2/`+geoidgrids` 网格文件、动态坐标系与极少数奇异投影（如 Laborade），遇到时会抛出含 PROJ 串的可读错误；
- `tbl_datum_transform` 是「早期绑定」单一首选参数，精度通常在米级；测绘级（厘米级）需求需网格改正，请用后端 PROJ/GDAL；
- srs.db 中 `wkt` 列为空、约 300 条纯垂直高程系（`+vunits=…`）不属于平面坐标转换范畴；
- srs.db 约 4.2 MB，浏览器首次加载需一次性下载并常驻内存（sql.js 约另需 0.6 MB wasm）。

## 开发

```bash
npm run build      # tsc 编译到 dist/
npm test           # 编译 + 41 项断言（Web Mercator 公式核对、基准转换一致性、9606 符号约定等）
npm run demo       # 打包演示页并起本地服务 http://127.0.0.1:8080
```

## 数据来源与致谢

- [QGIS](https://qgis.org/) `resources/srs.db`（GPL 许可的项目资源文件）；
- 坐标系定义源自 [EPSG Geodetic Parameter Dataset](https://epsg.org/)（© IOGP）；
- 计算由 [proj4js](https://github.com/proj4js/proj4) 与 [sql.js](https://github.com/sql-js/sql.js) 完成。
