import { SrsService, type SrsRecord } from '../src/index.js';

interface Preset {
  label: string;
  from: string;
  to: string;
  x: number;
  y: number;
}

const PRESETS: Preset[] = [
  { label: 'WGS84 → Web Mercator', from: 'EPSG:4326', to: 'EPSG:3857', x: 116.3913, y: 39.9075 },
  { label: 'WGS84 → CGCS2000 3°带 CM114E', from: 'EPSG:4326', to: 'EPSG:4547', x: 114, y: 40 },
  { label: '北京54 CM114E → WGS84', from: 'EPSG:2435', to: 'EPSG:4326', x: 500000, y: 4429607.3678 },
  { label: 'WGS84 → UTM 50N', from: 'EPSG:4326', to: 'EPSG:32650', x: 116.3913, y: 39.9075 },
  { label: '西安80 CM117E → WGS84', from: 'EPSG:2384', to: 'EPSG:4326', x: 500000, y: 4350000 },
];

const el = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

/** Searchable CRS picker: input + dropdown list fed by srs.search(). */
function createCombo(root: HTMLElement, initial: string, onPick: (code: string) => void) {
  root.innerHTML = `
    <input type="text" placeholder="例如 EPSG:4547 / 4326 / Gauss-Kruger" autocomplete="off" />
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
    commitTyped(input.value);
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
    const x = parseFloat(el<HTMLInputElement>('cx').value);
    const y = parseFloat(el<HTMLInputElement>('cy').value);
    const zRaw = el<HTMLInputElement>('cz').value.trim();
    if (!Number.isFinite(x) || !Number.isFinite(y)) throw new Error('请输入有效的 x / y 坐标。');
    const coord = zRaw === '' ? ([x, y] as [number, number]) : ([x, y, parseFloat(zRaw)] as [number, number, number]);

    const info = srs.inspect(from, to);
    // Echo the actually-resolved codes back into the inputs so display never disagrees with execution.
    fromCombo.value = info.from.code;
    toCombo.value = info.to.code;
    const out = inverse ? srs.transformInverse(coord, from, to) : srs.transform(coord, from, to);
    const [ox, oy] = Array.isArray(out) ? out : [out.x, out.y];
    const oz = Array.isArray(out) ? out[2] : out.z;

    result.classList.remove('error');
    result.textContent = zRaw !== '' ? `x = ${fmt(ox)}\ny = ${fmt(oy)}\nz = ${fmt(oz ?? 0)}` : `x = ${fmt(ox)}\ny = ${fmt(oy)}`;

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
        `const c = srs.toCesiumDegrees([${fmt(x)}, ${fmt(y)}${zRaw ? `, ${fmt(parseFloat(zRaw))}` : ''}], '${inverse ? to : from}');\n` +
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

let fromCombo: ReturnType<typeof createCombo>;
let toCombo: ReturnType<typeof createCombo>;

async function main() {
  const status = el('status');
  status.textContent = '正在加载 srs.db（约 4 MB）…';
  srs = await SrsService.create({ dbUrl: 'srs.db', locateFile: (f) => './' + f });
  el('db-count').textContent = String(srs.db.count());
  status.innerHTML = '<span class="ok">✓ srs.db 已加载（浏览器内 SQLite / sql.js）</span>';

  fromCombo = createCombo(el('from-combo'), 'EPSG:4326', () => {});
  toCombo = createCombo(el('to-combo'), 'EPSG:3857', () => {});

  el('btn-transform').addEventListener('click', () => run(false));
  el('btn-inverse').addEventListener('click', () => run(true));
  el('btn-swap').addEventListener('click', () => {
    const f = fromCombo.value;
    fromCombo.value = toCombo.value;
    toCombo.value = f;
    run(false);
  });

  const presets = el('presets');
  PRESETS.forEach((p) => {
    const btn = document.createElement('button');
    btn.textContent = p.label;
    btn.addEventListener('click', () => {
      fromCombo.value = p.from;
      toCombo.value = p.to;
      el<HTMLInputElement>('cx').value = String(p.x);
      el<HTMLInputElement>('cy').value = String(p.y);
      el<HTMLInputElement>('cz').value = '';
      run(false);
    });
    presets.appendChild(btn);
  });

  el<HTMLInputElement>('cx').value = '116.3913';
  el<HTMLInputElement>('cy').value = '39.9075';
  run(false);
}

main().catch((err) => {
  el('status').textContent = `加载失败：${(err as Error).message}`;
});
