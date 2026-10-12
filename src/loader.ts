import initSqlJs from 'sql.js';
import type { Database, SqlJsStatic } from 'sql.js';

/** Where and how to obtain the srs.db database. Provide exactly one of the three sources. */
export interface SrsSource {
  /** URL of the srs.db file to fetch (browser or Node ≥ 18 with global fetch). */
  dbUrl?: string;
  /** Raw bytes of srs.db already in memory. */
  dbData?: Uint8Array | ArrayBuffer;
  /** An already-open sql.js `Database` instance. It will NOT be closed by `SrsService.close()`. */
  database?: Database;
  /**
   * Maps the wasm filename sql.js asks for to the URL it can be downloaded from.
   * Default keeps it next to the current page — override for bundlers/CDNs, e.g.
   * `locateFile: (f) => 'https://cdn.jsdelivr.net/npm/sql.js@1.13.0/dist/' + f`
   */
  locateFile?: (file: string) => string;
  /** Custom sql.js initialiser (advanced). When omitted the bundled one is used. */
  sqlJsInit?: () => Promise<SqlJsStatic>;
}

let sqlJsPromise: Promise<SqlJsStatic> | undefined;

async function getSqlJs(locateFile?: (file: string) => string): Promise<SqlJsStatic> {
  sqlJsPromise ??= initSqlJs(locateFile ? { locateFile } : undefined);
  return sqlJsPromise;
}

/** Opens srs.db as a sql.js in-memory database. */
export async function openSrsDatabase(source: SrsSource): Promise<Database> {
  if (source.database) return source.database;

  const SQL = source.sqlJsInit ? await source.sqlJsInit() : await getSqlJs(source.locateFile);

  let bytes: Uint8Array | undefined;
  if (source.dbData) {
    bytes = source.dbData instanceof Uint8Array ? source.dbData : new Uint8Array(source.dbData);
  } else if (source.dbUrl !== undefined) {
    const res = await fetch(source.dbUrl);
    if (!res.ok) {
      throw new Error(`qgis-srs-transform: failed to download srs.db from ${source.dbUrl} (HTTP ${res.status}).`);
    }
    bytes = new Uint8Array(await res.arrayBuffer());
  }
  if (!bytes) {
    throw new Error("qgis-srs-transform: SrsSource must provide one of 'database', 'dbData' or 'dbUrl'.");
  }
  return new SQL.Database(bytes);
}
