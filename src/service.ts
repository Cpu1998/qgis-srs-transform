import { openSrsDatabase, type SrsSource } from './loader.js';
import { SrsDb } from './srs-db.js';
import { SrsTransformer } from './transform.js';
import type {
  Coord,
  CrsRef,
  SrsRecord,
  SearchOptions,
  ListSrsOptions,
  TransformInspection,
  TransformOptions,
} from './types.js';

/** Degrees, ready for `Cesium.Cartographic.fromDegrees` / `Cesium.Cartesian3.fromDegrees`. */
export interface CesiumDegrees {
  longitude: number;
  latitude: number;
  height: number;
}

/**
 * Facade over srs.db: CRS lookup + coordinate transformation.
 *
 * ```ts
 * const srs = await SrsService.create({ dbUrl: 'assets/srs.db' });
 * const [lon, lat] = srs.transform([500000, 4428236], 'EPSG:2435', 'EPSG:4326');
 * ```
 */
export class SrsService {
  private constructor(
    /** Raw query layer — exposed for advanced use. */
    public readonly db: SrsDb,
    private readonly transformer: SrsTransformer,
    private readonly ownsDatabase: boolean,
  ) {}

  /** Open srs.db (fetch URL / raw bytes / existing sql.js Database) and build the service. */
  static async create(source: SrsSource): Promise<SrsService> {
    const database = await openSrsDatabase(source);
    const db = new SrsDb(database);
    return new SrsService(db, new SrsTransformer(db), source.database === undefined);
  }

  /** Transform a coordinate from one CRS to another. */
  transform(coord: Coord, from: CrsRef, to: CrsRef, opts?: TransformOptions): Coord {
    return this.transformer.forward(coord, from, to, opts);
  }

  /** Inverse direction of `transform` (i.e. `to` → `from`). */
  transformInverse(coord: Coord, from: CrsRef, to: CrsRef, opts?: TransformOptions): Coord {
    return this.transformer.inverse(coord, from, to, opts);
  }

  /** Transform many coordinates at once (reuses the cached converter for the pair). */
  transformBatch(coords: Coord[], from: CrsRef, to: CrsRef, opts?: TransformOptions): Coord[] {
    return coords.map((c) => this.transformer.forward(c, from, to, opts));
  }

  /** Anything → WGS 84 geographic degrees (lon, lat). */
  toWgs84(coord: Coord, from: CrsRef, opts?: TransformOptions): Coord {
    return this.transformer.forward(coord, from, { auth: 'EPSG', id: 4326 }, opts);
  }

  /** WGS 84 geographic degrees (lon, lat) → any CRS. */
  fromWgs84(coord: Coord, to: CrsRef, opts?: TransformOptions): Coord {
    return this.transformer.forward(coord, { auth: 'EPSG', id: 4326 }, to, opts);
  }

  /**
   * Anything → Cesium-friendly degrees: `{longitude, latitude, height}`.
   * Feed directly to `Cesium.Cartesian3.fromDegrees(c.longitude, c.latitude, c.height)`
   * or `Cesium.Cartographic.fromDegrees(...)`.
   */
  toCesiumDegrees(coord: Coord, from: CrsRef, opts?: TransformOptions): CesiumDegrees {
    const out = this.transformer.forward(coord, from, { auth: 'EPSG', id: 4326 }, opts);
    const [x, y] = Array.isArray(out) ? out : [out.x, out.y];
    const z = Array.isArray(out) ? (out[2] ?? 0) : (out.z ?? 0);
    return { longitude: x, latitude: y, height: z };
  }

  /** Full record of a CRS (description, PROJ string, flags…). Throws when unknown. */
  describe(ref: CrsRef): SrsRecord {
    return this.transformer.resolve(ref);
  }

  /** Search CRS descriptions and authority ids, EPSG entries ranked first. */
  search(text: string, opts?: SearchOptions): SrsRecord[] {
    return this.db.search(text, opts);
  }

  /** Full catalog of all CRS definitions, for building QGIS-style browsers/trees. */
  list(opts?: ListSrsOptions): SrsRecord[] {
    return this.db.list(opts);
  }

  /** Show the effective PROJ strings and datum operations used for a (from → to) pair. */
  inspect(from: CrsRef, to: CrsRef, opts?: TransformOptions): TransformInspection {
    return this.transformer.inspect(from, to, opts);
  }

  /** Release the in-memory database (unless the caller supplied their own `Database`). */
  close(): void {
    if (this.ownsDatabase) this.db.close();
  }
}
