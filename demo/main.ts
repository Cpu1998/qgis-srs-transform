import { SrsService, type Coord, type SrsRecord } from '../src/index.js';
import { parseCoordinates, parseRawNumberPairs } from './coordParse.js';
import { createCrsPicker } from './crs-picker.js';

interface Preset {
  label: string;
  from: string;
  to: string;
  text: string;
}

const PRESETS: Preset[] = [
  { label: 'WGS84 → Web Mercator', from: 'EPSG:4326', to: 'EPSG:3857', text: '116.3913, 39.9075' },
  { label: '度分秒写法（WGS84 → 3857）', from: 'EPSG:4326', to: 'EPSG:3857', text: `118°46'30.5", 32°03'45.2"` },
  { label: 'WGS84 → CGCS2000 3°带 CM114E', from: 'EPSG:4326', to: 'EPSG:4547', text: '114, 40' },
  { label: '北京54 CM114E → WGS84', from: 'EPSG:2435', to: 'EPSG:4326', text: '500000, 4429607.3678' },
  { label: 'WGS84 → UTM 50N', from: 'EPSG:4326', to: 'EPSG:32650', text: '116.3913, 39.9075' },
  { label: '西安80 CM117E → WGS84', from: 'EPSG:2384', to: 'EPSG:4326', text: '500000, 4350000' },
  { label: 'WGS84 → 地心 ECEF', from: 'EPSG:4326', to: 'EPSG:4978', text: '114, 40, 0' },
];

const el = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

/** Searchable CRS picker: input + dropdown list fed by srs.search(). */
function createCombo(root: HTMLElement, initial: string, onPick: (code: string) => void) {
  root.innerHTML = `
    <input type="text" name="crs-quick-search" placeholder="输入编码或名称，如 4547 / Gauss-Kruger"
      aria-label="坐标系快速搜索" autocomplete="off" />
    <div class="list" hidden></div>`;
  const input = root.querySelector('input') as HTMLInputElement;
  const list = root.querySelector('.list') as HTMLDivElement;
  let selected = initial;
  let activeIndex = -1;

  function renderSelected() {
    input.value = selected;
    input.title = selected;
  }

  function renderList(records: SrsRecord[]) {
    list.innerHTML = '';
    records.forEach((r, i) => {
      const item = document.createElement('div');
      item.className = 'item' + (i === activeIndex ? ' active' : '');
      item.innerHTML = `<span class="code">${r.code}</span><span class="desc">${r.description}</span>`;
      item.title = `${r.code} — ${r.description}${r.deprecated ? '（已废弃）' : ''}`;
      item.onmousedown = (e) => {
        e.preventDefault();
        selected = r.code;
        renderSelected();
        list.hidden = true;
        onPick(selected);
      };
      list.appendChild(item);
    });
    list.hidden = records.length === 0;
  }

  /**
   * Commit raw typed text: accept a CRS code ("EPSG:4549", "4549") or an exact
   * description; otherwise fall back to the first search hit. Returns false when
   * nothing matches so the input can revert to the actually selected value.
   */
  function commitTyped(raw: string): boolean {
    const v = raw.trim();
    if (!v) return false;
    if (v === selected) return true;
    try {
      srs.describe(v); // throws when unresolvable
      selected = v;
      return true;
    } catch {
      const hit = srs.search(v, { limit: 1, includeDeprecated: true })[0];
      if (!hit) return false;
      selected = hit.code;
      return true;
    }
  }

  input.addEventListener('focus', () => {
    input.select();
    renderList(srs.search(input.value.trim() || selected, { limit: 40, includeDeprecated: true }));
  });
  input.addEventListener('input', () => {
    activeIndex = -1;
    renderList(srs.search(input.value.trim(), { limit: 40, includeDeprecated: true }));
  });
  // Fires on blur when the text changed: typed input must never be silently ignored.
  input.addEventListener('change', () => {
    if (commitTyped(input.value)) onPick(selected);
    renderSelected();
  });
  input.addEventListener('blur', () => setTimeout(() => (list.hidden = true), 120));
  input.addEventListener('keydown', (e) => {
    const items = [...list.querySelectorAll('.item')] as HTMLElement[];
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      if (list.hidden) input.dispatchEvent(new Event('focus'));
      activeIndex = e.key === 'ArrowDown' ? Math.min(activeIndex + 1, items.length - 1) : Math.max(activeIndex - 1, 0);
      renderList(srs.search(input.value.trim() || selected, { limit: 40, includeDeprecated: true }));
      items[activeIndex]?.scrollIntoView({ block: 'nearest' });
    } else if (e.key === 'Enter' && activeIndex >= 0) {
      items[activeIndex]?.dispatchEvent(new MouseEvent('mousedown', { preventDefault: true } as MouseEventInit));
    } else if (e.key === 'Enter') {
      // Raw code input like "EPSG:4547" or "4547".
      if (commitTyped(input.value)) {
        renderSelected();
        list.hidden = true;
        onPick(selected);
      }
    } else if (e.key === 'Escape') {
      list.hidden = true;
      renderSelected();
    }
  });

  renderSelected();
  return {
    get value() {
      return selected;
    },
    set value(code: string) {
      selected = code;
      renderSelected();
    },
    /** Commit whatever text is currently displayed (no-op when already committed). */
    commit() {
      commitTyped(input.value);
      renderSelected();
    },
    focus() {
      input.focus();
    },
  };
}

let srs: SrsService;

function describeDatumShift(op: { opCode: number; method: number; params: number[] } | undefined): string {
  if (!op) return '无（WGS84 或定义中已含基准信息）';
  const kind = op.method === 9606 ? '7 参数' : op.method === 9603 ? '3 参数' : `方法 ${op.method}`;
  return `EPSG:${op.opCode}（${kind} Helmert）`;
}

function fmt(v: number): string {
  return Number.isFinite(v) ? String(Number(v.toFixed(9))) : '—';
}

// #region Widget-style coordinate input (ported from the coordinate-location widget)

/** Input axis convention implied by a CRS (mirrors the widget's CoordSystemKind). */
type InputKind = 'geographic' | 'projected' | 'geocentric';

/** The "current point" kept as WGS84 — the anchor for refilling the input box. */
interface WgsPoint {
  longitude: number;
  latitude: number;
  height?: number;
}

type SettleResult =
  | { ok: true; wgs: WgsPoint; coord: [number, number] | [number, number, number] }
  | { ok: false; message: string };

const GEOGRAPHIC_SAMPLE = '118.78, 32.04';
const PROJECTED_SAMPLE = '500000, 4430000';
const GEOCENTRIC_SAMPLE = '-1990043.465, 4469710.804, 4077985.572';

/** Planar values below this on BOTH axes are almost surely not projected meters. */
const MIN_PLANAR_MAGNITUDE = 1000;

let swapXY = false;
let lastWgs: WgsPoint | null = null;
let fromCombo: ReturnType<typeof createCombo>;
let toCombo: ReturnType<typeof createCombo>;

function isPlausiblePlanarValue(x: number, y: number): boolean {
  return Math.abs(x) >= MIN_PLANAR_MAGNITUDE || Math.abs(y) >= MIN_PLANAR_MAGNITUDE;
}

function recordKind(record: SrsRecord): InputKind {
  if (record.srsType === 'Geocentric') return 'geocentric';
  if (record.isGeographic) return 'geographic';
  return 'projected';
}

/**
 * Parse the input box under a CRS and convert to WGS84, mirroring the widget's
 * convertToWgs84: geographic text goes through the DMS-aware parser, projected
 * and geocentric input through the raw numeric parser; results are range-checked.
 */
function settleInput(text: string, code: string, swap: boolean): SettleResult {
  const record = srs.describe(code);
  const kind = recordKind(record);

  if (kind === 'geocentric') {
    const triple = parseRawNumberPairs(text)[0];
    if (!triple) return { ok: false, message: `请输入地心坐标（X, Y, Z），例如：${GEOCENTRIC_SAMPLE}` };
    // proj4 would happily compute a wrong equatorial point with z=0 — reject instead.
    if (triple.z === undefined) return { ok: false, message: '地心坐标需要 X, Y, Z 三个数值（缺少 Z 轴无法换算经纬度）' };
    if (!isPlausiblePlanarValue(triple.x, triple.y)) {
      return { ok: false, message: `地心坐标以米为单位，当前数值过小，请确认坐标系是否选对（示例：${GEOCENTRIC_SAMPLE}）` };
    }
    return toWgsChecked([triple.x, triple.y, triple.z], code, record);
  }

  if (kind === 'projected') {
    const pair = parseRawNumberPairs(text)[0];
    if (!pair) return { ok: false, message: `请输入平面坐标，例如：${PROJECTED_SAMPLE}` };
    // North-first input is swapped back to (east, north) before proj4 sees it.
    const easting = swap ? pair.y : pair.x;
    const northing = swap ? pair.x : pair.y;
    if (!isPlausiblePlanarValue(easting, northing)) {
      return { ok: false, message: `投影坐标以米为单位，当前数值过小，请确认坐标系是否选对（示例：${PROJECTED_SAMPLE}）` };
    }
    return toWgsChecked(pair.z !== undefined ? [easting, northing, pair.z] : [easting, northing], code, record);
  }

  const point = parseCoordinates(text)[0];
  if (!point) return { ok: false, message: `请输入经纬度，例如：${GEOGRAPHIC_SAMPLE}（支持度分秒与纬度在前）` };
  const coord: [number, number] | [number, number, number] =
    point.height !== undefined ? [point.longitude, point.latitude, point.height] : [point.longitude, point.latitude];
  if (record.code === 'EPSG:4326') return { ok: true, wgs: point, coord };
  return toWgsChecked(coord, code, record);
}

/** Run the library conversion to WGS84 and validate the resulting degrees. */
function toWgsChecked(coord: [number, number] | [number, number, number], code: string, record: SrsRecord): SettleResult {
  let out: Coord;
  try {
    out = srs.toWgs84(coord, code);
  } catch {
    return { ok: false, message: `换算失败，请检查输入是否属于 ${record.description}` };
  }
  const [lon, lat] = Array.isArray(out) ? out : [out.x, out.y];
  if (!Number.isFinite(lon) || !Number.isFinite(lat) || Math.abs(lon) > 180 || Math.abs(lat) > 90) {
    return { ok: false, message: `换算结果超出经纬度范围，请检查坐标系是否选对（当前：${record.description}）` };
  }
  const z = Array.isArray(out) ? out[2] : out.z;
  const wgs: WgsPoint = { longitude: lon, latitude: lat };
  if (z !== undefined && Number.isFinite(z)) wgs.height = z;
  return { ok: true, wgs, coord };
}

/** Encode the current WGS84 point back into a CRS, for refilling the input box. */
function encodeWgsInto(code: string, wgs: WgsPoint, swap: boolean): string | null {
  const record = srs.describe(code);
  const kind = recordKind(record);
  const input: [number, number] | [number, number, number] =
    wgs.height !== undefined ? [wgs.longitude, wgs.latitude, wgs.height] : [wgs.longitude, wgs.latitude];
  let out: Coord;
  try {
    out = srs.fromWgs84(input, code);
  } catch {
    return null;
  }
  const [x, y] = Array.isArray(out) ? out : [out.x, out.y];
  const z = Array.isArray(out) ? out[2] : out.z;
  if (!Number.isFinite(x) || !Number.isFinite(y)) return null;
  const oriented = swap && kind === 'projected' ? [y, x] : [x, y];
  const values = z !== undefined && Number.isFinite(z) ? [...oriented, z] : oriented;
  const digits = kind === 'geographic' ? 8 : 3;
  return values.map((v) => v.toFixed(digits)).join(', ');
}

function hintTextFor(kind: InputKind, swap: boolean): string {
  if (kind === 'geocentric') {
    return `地心坐标系（ECEF）：按「X, Y, Z」输入，三轴均为米制分量，缺 Z 无法定位；示例：${GEOCENTRIC_SAMPLE}`;
  }
  if (kind === 'geographic') {
    return `支持十进制度、度分秒、带 东西经/南北纬 标识等写法，纬度在前也可自动识别；示例：${GEOGRAPHIC_SAMPLE}`;
  }
  const order = swap ? '北坐标, 东坐标' : '东坐标, 北坐标';
  const extra = swap ? '，解析与回填均按此顺序' : '';
  return `按「${order}」输入${extra}；若结果异常，请确认坐标系与投影形态是否选对，示例：${PROJECTED_SAMPLE}`;
}

function placeholderFor(kind: InputKind, swap: boolean): string {
  if (kind === 'geocentric') return `X, Y, Z（米），如 ${GEOCENTRIC_SAMPLE}`;
  if (kind === 'projected') return `${swap ? '北坐标, 东坐标' : '东坐标, 北坐标'}，如 ${PROJECTED_SAMPLE}`;
  return '经度,纬度，如 118.78,32.04';
}

/** Live WGS84 preview of the input under the source system (hidden when source IS WGS84). */
function refreshPreview(): void {
  const previewEl = el('wgs-preview');
  const from = fromCombo.value;
  if (from === 'EPSG:4326') {
    previewEl.textContent = '';
    return;
  }
  const text = el<HTMLInputElement>('coord-input').value.trim();
  if (!text) {
    previewEl.textContent = '';
    return;
  }
  const settled = settleInput(text, from, swapXY);
  if (!settled.ok) {
    previewEl.textContent = '';
    return;
  }
  const { longitude, latitude, height } = settled.wgs;
  previewEl.textContent =
    height !== undefined
      ? `WGS84：${longitude.toFixed(6)}, ${latitude.toFixed(6)}, ${height.toFixed(2)}m`
      : `WGS84：${longitude.toFixed(6)}, ${latitude.toFixed(6)}`;
}

/** Sync placeholder / hint / swap-checkbox visibility with the source CRS. */
function updateInputArea(): void {
  const record = srs.describe(fromCombo.value);
  const kind = recordKind(record);
  const input = el<HTMLInputElement>('coord-input');
  input.placeholder = placeholderFor(kind, swapXY);
  el('input-hint').textContent = hintTextFor(kind, swapXY);
  // The box affects whichever system the input belongs to: `from` forward, `to` inverse.
  const inputKindInverse = recordKind(srs.describe(toCombo.value));
  el('swap-xy-box').hidden = kind !== 'projected' && inputKindInverse !== 'projected';
}

/**
 * Refill the input box with the current point expressed in the (new) source CRS,
 * keeping input and CRS self-consistent after a system change — same as the widget.
 */
function refillInput(): void {
  if (!lastWgs) return;
  const text = encodeWgsInto(fromCombo.value, lastWgs, swapXY);
  if (text) el<HTMLInputElement>('coord-input').value = text;
}

function onFromChange(): void {
  refillInput();
  updateInputArea();
  refreshPreview();
}

// #endregion

function run(inverse: boolean) {
  const status = el('status');
  const result = el('result');
  const meta = el('meta');
  try {
    // Commit any typed-but-uncommitted CRS text first so the button always acts on what is displayed.
    fromCombo.commit();
    toCombo.commit();
    const from = fromCombo.value;
    const to = toCombo.value;

    // The input box belongs to the source system: `to` when running the inverse direction.
    const inputCode = inverse ? to : from;
    const swap = swapXY && recordKind(srs.describe(inputCode)) === 'projected';
    const settled = settleInput(el<HTMLInputElement>('coord-input').value, inputCode, swap);
    if (!settled.ok) throw new Error(settled.message);
    lastWgs = settled.wgs;

    const info = srs.inspect(from, to);
    // Echo the actually-resolved codes back into the inputs so display never disagrees with execution.
    fromCombo.value = info.from.code;
    toCombo.value = info.to.code;
    const out = inverse ? srs.transformInverse(settled.coord, from, to) : srs.transform(settled.coord, from, to);
    const [ox, oy] = Array.isArray(out) ? out : [out.x, out.y];
    const oz = Array.isArray(out) ? out[2] : out.z;
    const hasZ = oz !== undefined && Number.isFinite(oz);

    result.classList.remove('error');
    result.textContent = hasZ ? `x = ${fmt(ox)}\ny = ${fmt(oy)}\nz = ${fmt(oz!)}` : `x = ${fmt(ox)}\ny = ${fmt(oy)}`;

    meta.textContent =
      `${info.from.code}  ${info.from.description}\n` +
      `${info.to.code}  ${info.to.description}\n` +
      `源基准转换: ${describeDatumShift(info.fromDatumShift)}\n` +
      `目标基准转换: ${describeDatumShift(info.toDatumShift)}\n` +
      `源 PROJ: ${info.fromProj}\n目标 PROJ: ${info.toProj}`;

    const cesiumBox = el('cesium-box');
    const outRef = (inverse ? from : to).toUpperCase();
    if (outRef.endsWith(':4326') || outRef === '4326') {
      cesiumBox.hidden = false;
      el('cesium-code').textContent =
        `const c = srs.toCesiumDegrees([${settled.coord.map(fmt).join(', ')}], '${inverse ? to : from}');\n` +
        `Cesium.Cartesian3.fromDegrees(c.longitude, c.latitude, c.height);`;
    } else {
      cesiumBox.hidden = true;
    }

    status.innerHTML = `<span class="ok">✓ ${inverse ? '反向' : '正向'}转换完成</span>`;
  } catch (err) {
    result.classList.add('error');
    result.textContent = (err as Error).message;
    meta.textContent = '';
    el('cesium-box').hidden = true;
    status.textContent = '';
  }
}

async function main() {
  const status = el('status');
  status.textContent = '正在加载 srs.db（约 4 MB）…';
  srs = await SrsService.create({ dbUrl: 'srs.db', locateFile: (f) => './' + f });
  el('db-count').textContent = String(srs.db.count());
  status.innerHTML = '<span class="ok">✓ srs.db 已加载（浏览器内 SQLite / sql.js）</span>';

  fromCombo = createCombo(el('from-combo'), 'EPSG:4326', onFromChange);
  toCombo = createCombo(el('to-combo'), 'EPSG:3857', updateInputArea);

  const picker = createCrsPicker(srs);
  el('from-browse').addEventListener('click', () => {
    picker.open(fromCombo.value, (code) => {
      fromCombo.value = code;
      onFromChange();
    });
  });
  el('to-browse').addEventListener('click', () => {
    picker.open(toCombo.value, (code) => {
      toCombo.value = code;
    });
  });

  el('btn-transform').addEventListener('click', () => run(false));
  el('btn-inverse').addEventListener('click', () => run(true));
  el('btn-swap').addEventListener('click', () => {
    const f = fromCombo.value;
    fromCombo.value = toCombo.value;
    toCombo.value = f;
    onFromChange();
    run(false);
  });

  const input = el<HTMLInputElement>('coord-input');
  input.addEventListener('input', refreshPreview);
  el<HTMLInputElement>('swap-xy').addEventListener('change', (event) => {
    swapXY = (event.target as HTMLInputElement).checked;
    refillInput();
    updateInputArea();
    refreshPreview();
  });

  const presets = el('presets');
  PRESETS.forEach((p) => {
    const btn = document.createElement('button');
    btn.textContent = p.label;
    btn.addEventListener('click', () => {
      fromCombo.value = p.from;
      toCombo.value = p.to;
      el<HTMLInputElement>('coord-input').value = p.text;
      updateInputArea();
      run(false);
    });
    presets.appendChild(btn);
  });

  input.value = '116.3913, 39.9075';
  updateInputArea();
  run(false);
}

main().catch((err) => {
  el('status').textContent = `加载失败：${(err as Error).message}`;
});
