import type { SrsRecord, DatumTransformOp } from './types.js';

/** Minimal structural typing for the sql.js objects we use. */
interface StatementLike {
  bind(params?: unknown[]): boolean;
  step(): boolean;
  getAsObject(params?: unknown): Record<string, unknown>;
  free(): boolean;
}

interface DbLike {
  prepare(sql: string): StatementLike;
  close(): void;
}

function mapSrsRow(row: Record<string, unknown>): SrsRecord {
  const authName = String(row.auth_name);
  const authId = String(row.auth_id);
  return {
    srsId: Number(row.srs_id),
    authName,
    authId,
    code: `${authName}:${authId}`,
    description: String(row.description),
    projectionAcronym: String(row.projection_acronym ?? ''),
    ellipsoidAcronym: String(row.ellipsoid_acronym ?? ''),
    isGeographic: Number(row.is_geo) === 1,
    deprecated: Number(row.deprecated) === 1,
    proj: String(row.parameters ?? ''),
  };
}

function mapDatumRow(row: Record<string, unknown>): DatumTransformOp | null {
  const p = [1, 2, 3, 4, 5, 6, 7].map((i) => row[`p${i}`]).map((v) => (v == null ? undefined : Number(v)));
  // Trim to the leading run of non-null params: 3 for method 9603, 7 for the others.
  let last = -1;
  for (let i = 0; i < p.length; i++) if (p[i] !== undefined) last = i;
  if (last < 2) return null;
  const params = p.slice(0, last + 1).map((v) => v ?? 0);
  const method = Number(row.coord_op_method_code);
  return {
    opCode: Number(row.coord_op_code),
    sourceCrsCode: Number(row.source_crs_code),
    targetCrsCode: Number(row.target_crs_code),
    method: (method === 9606 || method === 9615 ? method : 9603) as 9603 | 9606 | 9615,
    params,
    preferred: Number(row.preferred) === 1,
  };
}

/** Thin typed query layer over an opened srs.db. */
export class SrsDb {
  constructor(private readonly db: DbLike) {}

  private all(sql: string, params: unknown[]): Record<string, unknown>[] {
    const stmt = this.db.prepare(sql);
    try {
      stmt.bind(params);
      const rows: Record<string, unknown>[] = [];
      while (stmt.step()) rows.push(stmt.getAsObject());
      return rows;
    } finally {
      stmt.free();
    }
  }

  private static readonly COLUMNS =
    'srs_id, description, projection_acronym, ellipsoid_acronym, parameters, auth_name, auth_id, is_geo, deprecated';

  getByCode(auth: string, id: string | number): SrsRecord | undefined {
    const rows = this.all(
      `SELECT ${SrsDb.COLUMNS} FROM tbl_srs
       WHERE auth_name = ? COLLATE NOCASE AND auth_id = ? COLLATE NOCASE LIMIT 1`,
      [auth, String(id)],
    );
    return rows[0] ? mapSrsRow(rows[0]) : undefined;
  }

  getByDescription(description: string): SrsRecord | undefined {
    const rows = this.all(`SELECT ${SrsDb.COLUMNS} FROM tbl_srs WHERE description = ? COLLATE NOCASE LIMIT 1`, [
      description,
    ]);
    return rows[0] ? mapSrsRow(rows[0]) : undefined;
  }

  /** Geographic CRS of an authority matching a description exactly (e.g. "Beijing 1954" → EPSG:4214). */
  getGeographicByDescription(auth: string, description: string): SrsRecord | undefined {
    const rows = this.all(
      `SELECT ${SrsDb.COLUMNS} FROM tbl_srs
       WHERE auth_name = ? COLLATE NOCASE AND is_geo = 1 AND description = ? COLLATE NOCASE LIMIT 1`,
      [auth, description],
    );
    return rows[0] ? mapSrsRow(rows[0]) : undefined;
  }

  /** Substring search over CRS descriptions, EPSG entries first. */
  search(text: string, opts: { limit?: number; includeDeprecated?: boolean } = {}): SrsRecord[] {
    const term = `%${text.replace(/[\\%_]/g, (m) => `\\${m}`)}%`;
    const limit = Math.max(1, Math.min(opts.limit ?? 50, 500));
    const depFilter = opts.includeDeprecated ? '' : 'AND deprecated = 0';
    return this.all(
      `SELECT ${SrsDb.COLUMNS} FROM tbl_srs
       WHERE description LIKE ? ESCAPE '\\' ${depFilter}
       ORDER BY (auth_name = 'EPSG') DESC, deprecated ASC, srs_id ASC
       LIMIT ?`,
      [term, limit],
    ).map(mapSrsRow);
  }

  /** EPSG Helmert operations from `tbl_datum_transform` for source→target (target usually 4326). */
  getDatumTransforms(sourceCrsCode: number, targetCrsCode = 4326): DatumTransformOp[] {
    return this.all(
      `SELECT coord_op_code, source_crs_code, target_crs_code, coord_op_method_code,
              p1, p2, p3, p4, p5, p6, p7, preferred
       FROM tbl_datum_transform
       WHERE source_crs_code = ? AND target_crs_code = ? AND deprecated = 0
       ORDER BY preferred DESC, coord_op_code ASC`,
      [sourceCrsCode, targetCrsCode],
    )
      .map(mapDatumRow)
      .filter((o): o is DatumTransformOp => o !== null);
  }

  getDatumTransform(opCode: number): DatumTransformOp | undefined {
    return this.all(
      `SELECT coord_op_code, source_crs_code, target_crs_code, coord_op_method_code,
              p1, p2, p3, p4, p5, p6, p7, preferred
       FROM tbl_datum_transform WHERE coord_op_code = ?`,
      [opCode],
    )
      .map(mapDatumRow)
      .find((o) => o !== null);
  }

  /** Total number of CRS definitions in tbl_srs. */
  count(): number {
    const rows = this.all('SELECT COUNT(*) AS n FROM tbl_srs', []);
    return Number(rows[0]?.n ?? 0);
  }

  close(): void {
    this.db.close();
  }
}
