import proj4 from 'proj4';
import type { Converter } from 'proj4';
import type { SrsDb } from './srs-db.js';
import type {
  Coord,
  CrsRef,
  DatumShiftOption,
  DatumTransformOp,
  SrsRecord,
  TransformInspection,
  TransformOptions,
} from './types.js';

/** proj4(from, to) converter: `forward` maps from→to, `inverse` maps to→from. */
type PairConverter = Converter;

const MAX_CONVERTER_CACHE = 512;

/** Convert an EPSG 9603/9606 operation into proj4 `+towgs84` parameter list (position-vector convention). */
function toTowgs84Params(op: DatumTransformOp): number[] {
  if (op.method === 9615) {
    throw new Error(
      `qgis-srs-transform: datum operation EPSG:${op.opCode} is an NTv2 grid transform (9615) which needs a grid file and cannot be applied by proj4. Pick a 9603/9606 operation or pass explicit towgs84 params.`,
    );
  }
  if (op.method === 9606) {
    const [dx, dy, dz, rx, ry, rz, ds] = op.params;
    // EPSG 9606 "Coordinate Frame rotation" uses the opposite rotation sign
    // convention from the 9607 position-vector form proj4 expects.
    return [dx, dy, dz, -rx, -ry, -rz, ds];
  }
  return op.params.slice(0, 3);
}

function appendTowgs84(proj: string, params: number[]): string {
  const ps = proj.trim();
  return `${ps} +towgs84=${params.join(',')}`;
}

function hasDatumInfo(proj: string): boolean {
  return /\+\s*(towgs84|datum|nadgrids)\s*=/.test(proj);
}

interface EffectiveDef {
  proj: string;
  record: SrsRecord;
  datumShift?: DatumTransformOp;
  explicitShift?: number[];
}

/** The projection/math layer. All heavy lifting happens here. */
export class SrsTransformer {
  private readonly pairCache = new Map<string, PairConverter>();

  constructor(private readonly srs: SrsDb) {}

  /** Resolve any supported CRS reference into an `SrsRecord`. */
  resolve(ref: CrsRef): SrsRecord {
    let auth = 'EPSG';
    let id: string;

    if (typeof ref === 'number') {
      if (!Number.isFinite(ref)) throw this.notFound(ref);
      id = String(ref);
    } else if (typeof ref === 'string') {
      const match = ref.match(/^([^:]+):(.+)$/);
      if (match) {
        auth = match[1].trim();
        id = match[2].trim();
      } else if (/^\d+$/.test(ref.trim())) {
        id = ref.trim();
      } else {
        // Treat as a CRS description, e.g. "WGS 84 / UTM zone 50N".
        const rec = this.srs.getByDescription(ref);
        if (rec) return rec;
        throw this.notFound(ref);
      }
    } else {
      auth = ref.auth;
      id = String(ref.id);
    }

    const rec = this.srs.getByCode(auth, id);
    if (!rec) throw this.notFound(ref);
    return rec;
  }

  private notFound(ref: CrsRef): Error {
    return new Error(
      `qgis-srs-transform: CRS "${String(
        typeof ref === 'object' ? `${ref.auth}:${ref.id}` : ref,
      )}" was not found in srs.db. Use search('...') to look up valid codes.`,
    );
  }

  /**
   * Geographic anchor CRS whose datum connects to WGS84 via `tbl_datum_transform`:
   * the CRS itself when geographic, otherwise the geographic CRS sharing the
   * description prefix before " / " (EPSG naming convention, e.g.
   * "Beijing 1954 / 3-degree Gauss-Kruger CM 114E" → "Beijing 1954" = EPSG:4214).
   */
  private geographicAnchor(rec: SrsRecord): number | undefined {
    if (rec.authName.toUpperCase() !== 'EPSG') return undefined;
    let anchor = rec;
    if (!rec.isGeographic) {
      const datumName = rec.description.split(' / ')[0].trim();
      if (!datumName) return undefined;
      const geo = this.srs.getGeographicByDescription('EPSG', datumName);
      if (!geo) return undefined;
      anchor = geo;
    }
    const code = Number(anchor.authId);
    return Number.isFinite(code) ? code : undefined;
  }

  private pickDatumOp(anchorCode: number, rec: SrsRecord, shift: DatumShiftOption): DatumTransformOp | undefined {
    if (shift === 'none') return undefined;
    if (typeof shift === 'number') {
      const op = this.srs.getDatumTransform(shift);
      if (!op) throw new Error(`qgis-srs-transform: datum operation ${shift} was not found in tbl_datum_transform.`);
      if (op.sourceCrsCode !== anchorCode) {
        throw new Error(
          `qgis-srs-transform: datum operation ${shift} transforms EPSG:${op.sourceCrsCode}→EPSG:${op.targetCrsCode}, which does not involve the datum of ${rec.code}.`,
        );
      }
      return op;
    }
    const ops = this.srs.getDatumTransforms(anchorCode, 4326).filter((o) => o.method !== 9615);
    return ops[0];
  }

  /** Build the PROJ string actually handed to proj4, with datum shift injected when appropriate. */
  private effectiveDef(rec: SrsRecord, shift: DatumShiftOption): EffectiveDef {
    const base = rec.proj.trim();
    if (shift === 'none' || hasDatumInfo(base)) return { proj: base, record: rec };

    if (Array.isArray(shift)) {
      if (shift.length !== 3 && shift.length !== 7) {
        throw new Error('qgis-srs-transform: explicit towgs84 params must have 3 or 7 elements.');
      }
      return { proj: appendTowgs84(base, shift), record: rec, explicitShift: shift };
    }

    const anchor = this.geographicAnchor(rec);
    if (anchor === undefined) return { proj: base, record: rec };
    const op = this.pickDatumOp(anchor, rec, shift);
    if (!op) return { proj: base, record: rec };
    return { proj: appendTowgs84(base, toTowgs84Params(op)), record: rec, datumShift: op };
  }

  private static shiftKey(shift: DatumShiftOption | undefined): string {
    return Array.isArray(shift) ? `p${shift.join(',')}` : String(shift ?? 'auto');
  }

  private converter(from: SrsRecord, to: SrsRecord, shift: DatumShiftOption | undefined): Converter {
    const key = `${from.code}>${to.code}|${SrsTransformer.shiftKey(shift)}`;
    const hit = this.pairCache.get(key);
    if (hit) return hit;

    const fromDef = this.effectiveDef(from, shift ?? 'auto');
    const toDef = this.effectiveDef(to, shift ?? 'auto');
    let converter: PairConverter;
    try {
      converter = proj4(fromDef.proj, toDef.proj);
    } catch (err) {
      throw new Error(
        `qgis-srs-transform: proj4 failed to initialise ${from.code} → ${to.code}. ` +
          `The "${from.projectionAcronym}/${to.projectionAcronym}" projection may be unsupported by proj4js. ` +
          `Source PROJ: ${fromDef.proj}; target PROJ: ${toDef.proj}. (${(err as Error).message})`,
      );
    }

    if (this.pairCache.size >= MAX_CONVERTER_CACHE) {
      const oldest = this.pairCache.keys().next().value;
      if (oldest !== undefined) this.pairCache.delete(oldest);
    }
    this.pairCache.set(key, converter);
    return converter;
  }

  forward(coord: Coord, from: CrsRef, to: CrsRef, opts?: TransformOptions): Coord {
    const converter = this.converter(this.resolve(from), this.resolve(to), opts?.datumShift);
    return mapOut(converter.forward(toPoint(coord)), coord);
  }

  inverse(coord: Coord, from: CrsRef, to: CrsRef, opts?: TransformOptions): Coord {
    const converter = this.converter(this.resolve(from), this.resolve(to), opts?.datumShift);
    return mapOut(converter.inverse(toPoint(coord)), coord);
  }

  /** Show what would actually be executed for a (from → to) pair: records, effective PROJ strings, datum ops. */
  inspect(from: CrsRef, to: CrsRef, opts?: TransformOptions): TransformInspection {
    const fromRec = this.resolve(from);
    const toRec = this.resolve(to);
    const shift = opts?.datumShift ?? 'auto';
    const fromDef = this.effectiveDef(fromRec, shift);
    const toDef = this.effectiveDef(toRec, shift);
    return {
      from: fromRec,
      to: toRec,
      fromProj: fromDef.proj,
      toProj: toDef.proj,
      fromDatumShift: fromDef.datumShift,
      toDatumShift: toDef.datumShift,
    };
  }
}

/** Normalise user input into the {x,y,z} shape proj4 accepts, validating values. */
function toPoint(coord: Coord): { x: number; y: number; z?: number } {
  if (Array.isArray(coord)) {
    const [x, y, z] = coord;
    if (!Number.isFinite(x) || !Number.isFinite(y)) {
      throw new Error('qgis-srs-transform: coordinate x/y must be finite numbers.');
    }
    return z === undefined ? { x, y } : { x, y, z };
  }
  const { x, y, z } = coord;
  if (!Number.isFinite(x) || !Number.isFinite(y)) {
    throw new Error('qgis-srs-transform: coordinate x/y must be finite numbers.');
  }
  return z === undefined ? { x, y } : { x, y, z };
}

/** Return the transformed point in the same shape the caller passed in. */
function mapOut(pt: { x: number; y: number; z?: number }, like: Coord): Coord {
  if (Array.isArray(like)) {
    return (like.length >= 3 ? [pt.x, pt.y, pt.z ?? 0] : [pt.x, pt.y]) as Coord;
  }
  return like.z !== undefined ? { x: pt.x, y: pt.y, z: pt.z ?? 0 } : { x: pt.x, y: pt.y };
}
