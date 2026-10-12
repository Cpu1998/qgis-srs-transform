/** Public type definitions shared across the library. */

/** One row of QGIS srs.db `tbl_srs` (a coordinate reference system definition). */
export interface SrsRecord {
  /** Numeric primary key used inside srs.db (internal, NOT the EPSG code). */
  srsId: number;
  /** Authority name, e.g. "EPSG", "ESRI", "IAU_2015", "IGNF". */
  authName: string;
  /** Authority id as stored in the db (string), e.g. "4326". */
  authId: string;
  /** Fully qualified code, e.g. "EPSG:4326". */
  code: string;
  /** Human readable CRS name, e.g. "WGS 84 / UTM zone 50N". */
  description: string;
  /** Projection acronym, e.g. "tmerc", "utm", "longlat". */
  projectionAcronym: string;
  /** Ellipsoid acronym, e.g. "GRS80", "WGS84". */
  ellipsoidAcronym: string;
  /** True for geographic (lon/lat) CRSs. */
  isGeographic: boolean;
  deprecated: boolean;
  /** PROJ string from the `parameters` column — the definition actually used for math. */
  proj: string;
}

/** A datum transformation row from `tbl_datum_transform` (Helmert params to WGS84). */
export interface DatumTransformOp {
  /** EPSG coordinate operation code (primary key). */
  opCode: number;
  sourceCrsCode: number;
  targetCrsCode: number;
  /** 9603 = geocentric translations (3 params), 9606 = coordinate frame rotation (7 params), 9615 = NTv2 grid (unsupported). */
  method: 9603 | 9606 | 9615;
  /** Helmert parameters: [dx,dy,dz] for 9603, [dx,dy,dz,rx,ry,rz,ds] for 9606. */
  params: number[];
  preferred: boolean;
}

/** Coordinate value: `[x, y]`, `[x, y, z]` or `{x, y, z?}`. */
export type Coord =
  | [number, number]
  | [number, number, number]
  | { x: number; y: number; z?: number };

/** CRS reference: EPSG id (`4326`), authority code string (`"EPSG:4326"`), or `{auth, id}`. */
export type CrsRef = number | string | { auth: string; id: number | string };

export interface SearchOptions {
  /** Max number of records to return (default 50). */
  limit?: number;
  /** Include deprecated CRSs (default false). */
  includeDeprecated?: boolean;
}

/**
 * Datum shift behaviour when a CRS definition carries no `+towgs84`/`+datum`/`+nadgrids`:
 * - `'auto'` (default): look up the preferred EPSG operation in `tbl_datum_transform`
 *   (e.g. Beijing 1954 / Xian 1980 → WGS 84) and inject it as `+towgs84`.
 * - `'none'`: use the PROJ string as-is (no datum shift).
 * - `number`: use a specific `tbl_datum_transform.coord_op_code`.
 * - `number[]`: explicit `+towgs84` params, `[dx,dy,dz]` or 7-element form.
 */
export type DatumShiftOption = 'auto' | 'none' | number | number[];

export interface TransformOptions {
  datumShift?: DatumShiftOption;
}

/** Details about how a (from → to) pair will be evaluated. Returned by `SrsService.inspect`. */
export interface TransformInspection {
  from: SrsRecord;
  to: SrsRecord;
  /** Effective PROJ string actually handed to proj4 for the source CRS. */
  fromProj: string;
  /** Effective PROJ string actually handed to proj4 for the target CRS. */
  toProj: string;
  /** Datum op injected into the source definition, if any. */
  fromDatumShift?: DatumTransformOp;
  /** Datum op injected into the target definition, if any. */
  toDatumShift?: DatumTransformOp;
}
