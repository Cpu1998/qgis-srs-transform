/**
 * Type declarations for the (untyped) sql.js package — only the surface used by this library.
 * Remove when sql.js starts shipping its own types.
 */
declare module 'sql.js' {
  export interface Statement {
    bind(params?: unknown[]): boolean;
    step(): boolean;
    getAsObject(params?: unknown): Record<string, unknown>;
    free(): boolean;
    run(params?: unknown): boolean;
    reset(): boolean;
  }

  export interface QueryExecResult {
    columns: string[];
    values: unknown[][];
  }

  export interface Database {
    prepare(sql: string): Statement;
    exec(sql: string, params?: unknown[]): QueryExecResult[];
    run(sql: string, params?: unknown[]): Database;
    close(): void;
    export(): Uint8Array;
  }

  export interface SqlJsConfig {
    locateFile?: (filename: string) => string;
  }

  export interface SqlJsStatic {
    Database: new (data?: Uint8Array | null) => Database;
  }

  export default function initSqlJs(config?: SqlJsConfig): Promise<SqlJsStatic>;
}
