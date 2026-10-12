/**
 * QGIS-style CRS browser dialog (vanilla port of the DXApp
 * coordinate-location widget's CoordinateSystemDialog).
 *
 * Features ported from the widget:
 * - full-catalog tree grouped by QGIS `srs_type`, projected CRSs subdivided
 *   by PROJ projection method (same group order as the QGIS selector);
 * - debounced search matching description / authority id / type group /
 *   projection method word-by-word (QGIS filter semantics);
 * - "hide deprecated" toggle, deprecated & current tags, selection highlight;
 * - recently used list persisted in localStorage.
 *
 * Child rows render lazily on group expand so the ~13k-record catalog never
 * hits the DOM in one shot; a non-empty search auto-expands the matches.
 */
import type { SrsService, SrsRecord } from '../src/index.js';

/** srs_type → first-level tree node; order matches the QGIS CRS selector. */
const SRS_TYPE_GROUPS = [
  { types: ['Geodetic'], id: 'geodetic', label: '大地' },
  { types: ['Geographic2d'], id: 'geographic-2d', label: '地理（2D）' },
  { types: ['Geographic3d'], id: 'geographic-3d', label: '地理（3D）' },
  { types: ['Geocentric'], id: 'geocentric', label: '地心' },
  { types: ['Compound'], id: 'compound', label: '复合' },
  { types: ['Projected', 'DerivedProjected'], id: 'projected', label: '投影' },
  { types: ['Vertical'], id: 'vertical', label: '垂直' },
  { types: ['Temporal'], id: 'temporal', label: '时间' },
  { types: ['Engineering'], id: 'engineering', label: '工程' },
  { types: ['Bound'], id: 'bound', label: '绑定' },
  { types: ['Other'], id: 'other', label: '其他' },
  { types: ['Unknown'], id: 'unknown', label: '未知' },
];

/** Common PROJ projection methods with zh/en display names; raw acronym as fallback. */
const PROJECTION_METHOD_NAMES: Record<string, string> = {
  aea: '阿尔伯斯等面积 - Albers Equal Area',
  aeqd: '方位等距 - Azimuthal Equidistant',
  cass: '卡西尼 - Cassini',
  cea: '圆柱等面积 - Cylindrical Equal Area',
  comill: '紧凑米勒 - Compact Miller',
  crast: '克拉斯坦 - Craster Parabolic',
  eck1: '埃克特 I - Eckert I',
  eck2: '埃克特 II - Eckert II',
  eck3: '埃克特 III - Eckert III',
  eck4: '埃克特 IV - Eckert IV',
  eck5: '埃克特 V - Eckert V',
  eck6: '埃克特 VI - Eckert VI',
  eqearth: '等地球 - Equal Earth',
  eqc: '等距圆柱 - Equidistant Cylindrical',
  eqdc: '等距圆锥 - Equidistant Conic',
  gall: '高尔立体 - Gall Stereographic',
  geocent: '地心 - Geocentric',
  geos: '地球静止卫星视角 - Geostationary Satellite View',
  gnom: '球心投影 - Gnomonic',
  goode: '古德同源间断 - Interrupted Goode Homolosine',
  gstmerc: '高斯-施赖伯横轴墨卡托 - Gauss Schreiber Transverse Mercator',
  lcc: '兰伯特共形圆锥 - Lambert Conformal Conic',
  laea: '兰伯特方位等面积 - Lambert Azimuthal Equal Area',
  longlat: '经纬度 - Longitude / Latitude',
  merc: '墨卡托 - Mercator',
  mill: '米勒圆柱 - Miller Cylindrical',
  moll: '摩尔维德 - Mollweide',
  natearth: '自然地球 - Natural Earth',
  natearth2: '自然地球 II - Natural Earth II',
  nzmg: '新西兰地图格网 - New Zealand Map Grid',
  omerc: '斜轴墨卡托 - Oblique Mercator',
  ortho: '正射方位 - Orthographic',
  patterson: '帕特森 - Patterson',
  poly: '多圆锥 - Polyconic',
  robin: '罗宾逊 - Robinson',
  sinu: '桑森-弗拉姆斯蒂德 - Sinusoidal',
  somerc: '瑞士斜轴墨卡托 - Swiss Oblique Mercator',
  stere: '极地立体 - Polar Stereographic',
  sterea: '双立体 - Double Stereographic',
  tmerc: '横轴墨卡托 - Transverse Mercator',
  utm: '通用横轴墨卡托 - Universal Transverse Mercator',
};

/** Search index entry: lowercase forms precomputed once per catalog load. */
interface SearchEntry {
  record: SrsRecord;
  codeLower: string;
  searchable: string;
}

interface TreeNode {
  id: string;
  label: string;
  authority: string;
  /** Selectable CRS code; group nodes leave it unset. */
  value?: string;
  record?: SrsRecord;
  children?: TreeNode[];
}

const RECENT_KEY = 'qgis-srs-demo/recent-crs';
const RECENT_LIMIT = 8;

const el = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

function srsTypeLabel(srsType: string): string {
  return SRS_TYPE_GROUPS.find((item) => item.types.includes(srsType))?.label ?? '其他';
}

function projectionMethodLabel(method: string): string {
  if (!method || method === 'unknown') return '其他投影';
  return PROJECTION_METHOD_NAMES[method] ?? `其他投影（${method}）`;
}

function loadRecent(): string[] {
  try {
    const raw = JSON.parse(localStorage.getItem(RECENT_KEY) ?? '[]');
    return Array.isArray(raw) ? raw.filter((v): v is string => typeof v === 'string').slice(0, RECENT_LIMIT) : [];
  } catch {
    return [];
  }
}

function saveRecent(codes: string[]): void {
  try {
    localStorage.setItem(RECENT_KEY, JSON.stringify(codes));
  } catch {
    // storage unavailable — recency just won't persist
  }
}

/**
 * Build the picker controller. `open(current, onApply)` shows the dialog;
 * `onApply` fires with the committed CRS code (already recorded in recents).
 */
export function createCrsPicker(srs: SrsService): { open(current: string, onApply: (code: string) => void): void } {
  const dialog = el<HTMLDialogElement>('crs-dialog');
  const queryInput = el<HTMLInputElement>('crs-query');
  const hideDeprecatedInput = el<HTMLInputElement>('crs-hide-deprecated');
  const recentBox = el('crs-recent');
  const recentCount = el('crs-recent-count');
  const treeBox = el('crs-tree');
  const treeEmpty = el('crs-tree-empty');

  let entries: SearchEntry[] | null = null;
  let currentCode = '';
  let selectedCode = '';
  let onApply: ((code: string) => void) | null = null;
  let debounceTimer: ReturnType<typeof setTimeout> | undefined;

  function ensureEntries(): SearchEntry[] {
    if (!entries) {
      entries = srs.list({ includeDeprecated: true }).map((record) => ({
        record,
        codeLower: record.code.toLocaleLowerCase(),
        searchable: `${record.description} ${srsTypeLabel(record.srsType)} ${projectionMethodLabel(
          record.projectionAcronym,
        )}`.toLocaleLowerCase(),
      }));
    }
    return entries;
  }

  /** QGIS filter semantics: authority-id substring hit, or every term matches the text blob. */
  function matches(entry: SearchEntry, normalized: string, terms: string[]): boolean {
    if (!normalized) return true;
    if (entry.codeLower.includes(normalized)) return true;
    return terms.every((term) => entry.searchable.includes(term));
  }

  function filteredRecords(): SrsRecord[] {
    const normalized = queryInput.value.trim().toLocaleLowerCase();
    const terms = normalized.split(/\s+/).filter(Boolean);
    return ensureEntries()
      .filter((entry) => (!hideDeprecatedInput.checked || !entry.record.deprecated) && matches(entry, normalized, terms))
      .map((entry) => entry.record);
  }

  function buildTree(records: SrsRecord[]): TreeNode[] {
    const knownTypes = new Set<string>(SRS_TYPE_GROUPS.flatMap((item) => item.types));
    const group = (id: string, label: string, items: SrsRecord[]): TreeNode | undefined =>
      items.length
        ? {
            id: `group:${id}`,
            label,
            authority: '',
            children: items.map((record) => ({
              id: record.code,
              label: record.description,
              authority: record.code,
              value: record.code,
              record,
            })),
          }
        : undefined;

    const nodes: TreeNode[] = [];
    for (const { types, id, label } of SRS_TYPE_GROUPS) {
      const items = records.filter((record) => types.includes(record.srsType));
      if (id !== 'projected') {
        const node = group(id, label, items);
        if (node) nodes.push(node);
        continue;
      }
      // Projected: subdivide by projection method, sorted by display label.
      if (!items.length) continue;
      const methods = new Map<string, SrsRecord[]>();
      for (const record of items) {
        const method = record.projectionAcronym || 'unknown';
        const list = methods.get(method);
        if (list) list.push(record);
        else methods.set(method, [record]);
      }
      nodes.push({
        id: `group:${id}`,
        label,
        authority: '',
        children: Array.from(methods.entries())
          .sort(([left], [right]) => projectionMethodLabel(left).localeCompare(projectionMethodLabel(right), 'zh-Hans-CN'))
          .map(([method, list]) => group(`${id}:${method}`, projectionMethodLabel(method), list))
          .filter((node): node is TreeNode => Boolean(node)),
      });
    }
    // srs_type values outside the known set land in a trailing "其他" group.
    const other = group('other-tail', '其他', records.filter((record) => !knownTypes.has(record.srsType)));
    if (other) nodes.push(other);
    return nodes;
  }

  /** One selectable row (tree leaf or recent entry). Click selects, dblclick applies. */
  function createRow(node: TreeNode): HTMLElement {
    const row = document.createElement('div');
    row.className = 'crs-leaf';
    row.dataset.value = node.value ?? '';
    if (node.value === currentCode) row.classList.add('is-current');
    if (node.value === selectedCode) row.classList.add('is-selected');

    const label = document.createElement('span');
    label.className = 'crs-leaf__label';
    const text = document.createElement('span');
    text.textContent = node.label;
    text.title = `${node.label}（${node.value}）`;
    label.appendChild(text);
    if (node.record?.deprecated) {
      const tag = document.createElement('span');
      tag.className = 'tag tag--deprecated';
      tag.textContent = '已废弃';
      label.appendChild(tag);
    }
    if (node.value === currentCode) {
      const tag = document.createElement('span');
      tag.className = 'tag';
      tag.textContent = '当前';
      label.appendChild(tag);
    }

    const authority = document.createElement('span');
    authority.className = 'crs-leaf__authority';
    authority.textContent = node.authority;

    row.append(label, authority);
    row.addEventListener('click', () => select(node.value!));
    row.addEventListener('dblclick', () => {
      select(node.value!);
      apply();
    });
    return row;
  }

  /**
   * Render tree nodes into a container. Group nodes get a header plus a lazily
   * populated children container (records render as selectable leaf rows);
   * while filtering everything renders expanded, mirroring the widget's
   * default-expand-all behaviour.
   */
  function renderNodes(container: HTMLElement, nodes: TreeNode[], depth: number, filtering: boolean): void {
    const fragment = document.createDocumentFragment();
    for (const node of nodes) {
      if (!node.children) {
        fragment.appendChild(createRow(node));
        continue;
      }

      const groupRow = document.createElement('div');
      groupRow.className = 'crs-group';
      groupRow.style.paddingLeft = `${depth * 18 + 8}px`;

      const caret = document.createElement('span');
      caret.className = 'crs-group__caret';
      const title = document.createElement('span');
      title.className = 'crs-group__label';
      title.textContent = node.label;
      const count = document.createElement('span');
      count.className = 'crs-group__count';
      count.textContent = `${node.children.length}`;
      groupRow.append(caret, title, count);

      const children = document.createElement('div');
      children.className = 'crs-tree__children';
      children.hidden = true;

      groupRow.addEventListener('click', () => {
        const expand = children.hidden;
        if (expand && children.childElementCount === 0) renderNodes(children, node.children!, depth + 1, filtering);
        children.hidden = !expand;
        groupRow.classList.toggle('is-open', expand);
      });

      fragment.append(groupRow, children);
      if (filtering) {
        renderNodes(children, node.children, depth + 1, filtering);
        children.hidden = false;
        groupRow.classList.add('is-open');
      }
    }
    container.appendChild(fragment);
  }

  function renderTree(): void {
    const records = filteredRecords();
    const tree = buildTree(records);
    treeBox.innerHTML = '';
    treeEmpty.hidden = tree.length > 0;
    renderNodes(treeBox, tree, 0, queryInput.value.trim() !== '');
  }

  function renderRecent(): void {
    recentBox.innerHTML = '';
    const codes = loadRecent();
    recentCount.textContent = `${codes.length} 项`;
    if (!codes.length) {
      const empty = document.createElement('div');
      empty.className = 'crs-empty-row';
      empty.textContent = '暂无最近使用的坐标系';
      recentBox.appendChild(empty);
      return;
    }
    const fragment = document.createDocumentFragment();
    for (const code of codes) {
      let label = code;
      let authority = code.includes(':') ? code.toUpperCase() : code;
      try {
        const record = srs.describe(code);
        label = record.description;
        authority = record.code;
      } catch {
        // unknown/offline entry — show the raw code
      }
      fragment.appendChild(
        createRow({ id: `recent:${code}`, label, authority, value: code }),
      );
    }
    recentBox.appendChild(fragment);
  }

  function markSelection(): void {
    dialog.querySelectorAll('.crs-leaf.is-selected').forEach((node) => node.classList.remove('is-selected'));
    if (!selectedCode) return;
    dialog
      .querySelectorAll(`.crs-leaf[data-value="${CSS.escape(selectedCode)}"]`)
      .forEach((node) => node.classList.add('is-selected'));
  }

  function select(code: string): void {
    selectedCode = code;
    markSelection();
  }

  function apply(): void {
    if (!selectedCode) return;
    const recent = [selectedCode, ...loadRecent().filter((code) => code !== selectedCode)].slice(0, RECENT_LIMIT);
    saveRecent(recent);
    onApply?.(selectedCode);
    dialog.close();
  }

  queryInput.addEventListener('input', () => {
    if (debounceTimer !== undefined) clearTimeout(debounceTimer);
    debounceTimer = setTimeout(renderTree, 300);
  });
  queryInput.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') {
      event.preventDefault();
      // Enter applies the first visible leaf when nothing is selected yet.
      if (!selectedCode) {
        const first = treeBox.querySelector<HTMLElement>('.crs-leaf');
        if (first?.dataset.value) select(first.dataset.value);
      }
      apply();
    }
  });
  hideDeprecatedInput.addEventListener('change', renderTree);
  el('crs-apply').addEventListener('click', apply);
  el('crs-cancel').addEventListener('click', () => dialog.close());
  el('crs-close').addEventListener('click', () => dialog.close());

  return {
    open(current: string, applyHandler: (code: string) => void) {
      currentCode = current;
      selectedCode = current;
      onApply = applyHandler;
      queryInput.value = '';
      hideDeprecatedInput.checked = false;
      renderRecent();
      renderTree();
      dialog.showModal();
      queryInput.focus();
    },
  };
}
