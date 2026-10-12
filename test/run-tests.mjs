/**
 * Node test suite for qgis-srs-transform (runs against compiled dist/).
 * Run: npm test
 */
import { readFileSync } from 'node:fs';
import proj4 from 'proj4';
import { SrsService } from '../dist/index.js';

const dbData = readFileSync(new URL('../srs.db', import.meta.url));
const srs = await SrsService.create({ dbData });

let passed = 0;
let failed = 0;
const failures = [];

function check(name, cond, detail = '') {
  if (cond) {
    passed++;
    console.log(`  ok  ${name}`);
  } else {
    failed++;
    failures.push(`${name}${detail ? ` — ${detail}` : ''}`);
    console.log(`FAIL  ${name}${detail ? ` — ${detail}` : ''}`);
  }
}

function approx(name, actual, expected, eps) {
  check(
    name,
    Math.abs(actual - expected) <= eps,
    `actual=${actual} expected=${expected} eps=${eps}`,
  );
}

console.log('\n== T1: EPSG:4326 → EPSG:3857 vs closed-form Web Mercator ==');
{
  const R = 6378137;
  const lon = 116.3913;
  const lat = 39.9075;
  const [mx, my] = srs.transform([lon, lat], 'EPSG:4326', 'EPSG:3857');
  const ex = (lon / 180) * Math.PI * R;
  const ey = R * Math.log(Math.tan(Math.PI / 4 + (lat * Math.PI) / 360));
  approx('x matches formula', mx, ex, 1e-6);
  approx('y matches formula', my, ey, 1e-6);
}

console.log('\n== T2: EPSG:3857 → EPSG:4326 roundtrip ==');
{
  const [lon, lat] = srs.transform([12957112.6, 4852262.6], 'EPSG:3857', 'EPSG:4326');
  const [mx, my] = srs.transform([lon, lat], 'EPSG:4326', 'EPSG:3857');
  approx('x roundtrip', mx, 12957112.6, 1e-6);
  approx('y roundtrip', my, 4852262.6, 1e-6);
}

console.log('\n== T3: EPSG:4326 → EPSG:4547 (CGCS2000 / GK CM 114E) ==');
{
  const [x, y] = srs.transform([114, 40], 'EPSG:4326', 'EPSG:4547');
  approx('x = false easting on central meridian', x, 500000, 1e-3);
  const [lon, lat] = srs.transform([x, y], 'EPSG:4547', 'EPSG:4326');
  approx('lon roundtrip', lon, 114, 1e-9);
  approx('lat roundtrip', lat, 40, 1e-9);
  check('northing plausible for 40°', y > 4427000 && y < 4430000, `y=${y}`);
}

console.log('\n== T4: Beijing 1954 (EPSG:4214) → WGS84 with db datum shift ==');
{
  // Preferred 3-param op in tbl_datum_transform for 4214→4326 is EPSG:15921.
  const ops = srs.db.getDatumTransforms(4214, 4326);
  check('datum ops found', ops.length > 0);
  const preferred = ops.find((o) => o.preferred);
  check('preferred op is 15921', preferred?.opCode === 15921, `got ${preferred?.opCode}`);

  const [lon, lat] = srs.transform([114, 40], 'EPSG:4214', 'EPSG:4326');
  const manual = proj4(
    '+proj=longlat +ellps=krass +towgs84=15.8,-154.4,-82.3 +no_defs',
    '+proj=longlat +datum=WGS84 +no_defs',
    { x: 114, y: 40 },
  );
  approx('lon matches manual proj4', lon, manual.x, 1e-12);
  approx('lat matches manual proj4', lat, manual.y, 1e-12);
  const dLonM = Math.abs(lon - 114) * 111320 * Math.cos((40 * Math.PI) / 180);
  const dLatM = Math.abs(lat - 40) * 110574;
  check('shift applied (≈60 m for Beijing 1954)', dLonM + dLatM > 30, `dLon=${dLonM.toFixed(1)}m dLat=${dLatM.toFixed(1)}m`);
  check('shift magnitude sane (<1 km)', dLonM + dLatM < 1000);
}

console.log('\n== T5: projected Beijing 1954 (EPSG:2435) inherits datum shift ==');
{
  // Ground truth point: forward-project (114°E, 40°N) without datum shift → exact GK coordinates.
  const [px, py] = srs.transform([114, 40], 'EPSG:4326', 'EPSG:2435', { datumShift: 'none' });
  approx('pure projection x = 500000', px, 500000, 1e-6);

  const [xNo, yNo] = srs.transform([px, py], 'EPSG:2435', 'EPSG:4326', { datumShift: 'none' });
  approx('no-shift inverse lon', xNo, 114, 1e-9);
  approx('no-shift inverse lat', yNo, 40, 1e-9);

  const [xSh, ySh] = srs.transform([px, py], 'EPSG:2435', 'EPSG:4326');
  const dLonM = Math.abs(xSh - xNo) * 111320 * Math.cos((40 * Math.PI) / 180);
  const dLatM = Math.abs(ySh - yNo) * 110574;
  check('auto shift differs from none by >30 m', dLonM + dLatM > 30, `dLon=${dLonM.toFixed(1)}m dLat=${dLatM.toFixed(1)}m`);

  // Same geographic point via the geographic CRS must agree: 4214 → 4326.
  const [sx, sy] = srs.transform([114, 40], 'EPSG:4214', 'EPSG:4326');
  approx('projected route lon == geographic route lon', xSh, sx, 1e-9);
  approx('projected route lat == geographic route lat', ySh, sy, 1e-9);
}

console.log('\n== T6: 7-parameter (9606) sign convention: Palestine 1923 EPSG:4281 ==');
{
  const op = srs.db.getDatumTransforms(4281, 4326).find((o) => o.method === 9606);
  check('9606 op exists for 4281', op !== undefined);
  if (op) {
    // +towgs84 must hold the position-vector form: rotations negated for coordinate-frame (9606).
    const [dx, dy, dz, rx, ry, rz, ds] = op.params;
    const expected = `+towgs84=${[dx, dy, dz, -rx, -ry, -rz, ds].join(',')}`;
    const info = srs.inspect('EPSG:4281', 'EPSG:4326');
    check(
      '9606 rotations negated in injected towgs84',
      info.fromProj.includes(expected),
      `expected ...${expected}... in "${info.fromProj}"`,
    );
    const manual = proj4(
      `${srs.describe('EPSG:4281').proj} +towgs84=${[dx, dy, dz, -rx, -ry, -rz, ds].join(',')}`,
      '+proj=longlat +datum=WGS84 +no_defs',
      { x: 35.13, y: 31.9 },
    );
    const out = srs.transform([35.13, 31.9], 'EPSG:4281', 'EPSG:4326');
    approx('4281 lon matches manual 7-param', out[0], manual.x, 1e-12);
    approx('4281 lat matches manual 7-param', out[1], manual.y, 1e-12);
  }
}

console.log('\n== T7: lookup / search / errors ==');
{
  check('number ref works', srs.describe(4326).code === 'EPSG:4326');
  check('object ref works', srs.describe({ auth: 'EPSG', id: 3857 }).description.includes('Pseudo-Mercator'));
  check('description ref works', srs.describe('WGS 84 / UTM zone 50N').code === 'EPSG:32650');
  check('ESRI code works', srs.describe('ESRI:54009').authName === 'ESRI');
  const hits = srs.search('Gauss-Kruger CM 114E');
  const codes = new Set(hits.map((h) => h.code));
  check('search finds 4547 & 2435', codes.has('EPSG:4547') && codes.has('EPSG:2435'), [...codes].slice(0, 8).join(','));
  let threw = false;
  try {
    srs.describe('EPSG:99999999');
  } catch (e) {
    threw = true;
    check('unknown CRS error mentions srs.db', String(e.message).includes('not found'));
  }
  check('unknown CRS throws', threw);
}

console.log('\n== T8: shapes, batch, z passthrough, cesium helper ==');
{
  const py40 = srs.transform([114, 40], 'EPSG:4326', 'EPSG:4547', { datumShift: 'none' })[1];
  const arr = srs.transform([116, 40], 4326, 3857);
  check('array in → array out', Array.isArray(arr) && arr.length === 2);
  const obj = srs.transform({ x: 116, y: 40, z: 100 }, 4326, 3857);
  check('object in → object out with z', typeof obj === 'object' && !Array.isArray(obj) && obj.z === 100);
  const batch = srs.transformBatch(
    [
      [116, 40],
      [117, 41],
    ],
    4326,
    3857,
  );
  check('batch length & values', batch.length === 2 && batch[0][0] === arr[0] && batch[1][0] !== arr[0]);
  const c = srs.toCesiumDegrees([500000, py40], 'EPSG:4547');
  check('toCesiumDegrees degrees', Math.abs(c.longitude - 114) < 0.001 && Math.abs(c.latitude - 40) < 0.001 && c.height === 0);
  const cz = srs.toCesiumDegrees({ x: 500000, y: py40, z: 55 }, 'EPSG:4547');
  check('toCesiumDegrees keeps height', cz.height === 55);
  const [ix, iy] = srs.transformInverse(arr, 4326, 3857);
  approx('transformInverse', ix, 116, 1e-9);
}

console.log('\n== T9: inspect exposes effective defs ==');
{
  const info = srs.inspect('EPSG:2435', 'EPSG:4326');
  check('from record', info.from.code === 'EPSG:2435');
  check('datum shift reported', info.fromDatumShift?.opCode === 15921, `got ${info.fromDatumShift?.opCode}`);
  check('towgs84 appended', info.fromProj.includes('+towgs84='));
  const plain = srs.inspect('EPSG:4326', 'EPSG:3857');
  check('no shift for WGS84 source', plain.fromDatumShift === undefined && !plain.fromProj.includes('+towgs84'));
}

console.log('\n== T10: stress across all EPSG projected CRSs (parse coverage) ==');
{
  const all = srs.search('', { limit: 500, includeDeprecated: true });
  const epsgProjected = all.filter((r) => r.authName === 'EPSG' && !r.isGeographic);
  let okCount = 0;
  const errs = [];
  for (const rec of [...epsgProjected].slice(0, 120)) {
    try {
      proj4(rec.proj, '+proj=longlat +datum=WGS84 +no_defs');
      okCount++;
    } catch {
      errs.push(rec.code);
    }
  }
  console.log(`  proj4js parsed ${okCount}/${Math.min(120, epsgProjected.length)} sampled EPSG projected CRSs`);
  if (errs.length) console.log(`  unsupported (expected for exotic projections): ${errs.slice(0, 10).join(', ')}...`);
}

srs.close();
console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) {
  console.log('\nFailures:');
  for (const f of failures) console.log(` - ${f}`);
  process.exit(1);
}
