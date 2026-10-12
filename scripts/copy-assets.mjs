/** Copy runtime assets (srs.db + sql.js wasm) next to the demo bundle. */
import { copyFileSync, existsSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const demoDir = join(root, 'demo');
mkdirSync(demoDir, { recursive: true });

const wasmSrc = join(root, 'node_modules', 'sql.js', 'dist', 'sql-wasm.wasm');
const wasmBrowserSrc = join(root, 'node_modules', 'sql.js', 'dist', 'sql-wasm-browser.wasm');
copyFileSync(join(root, 'srs.db'), join(demoDir, 'srs.db'));
if (existsSync(wasmSrc)) copyFileSync(wasmSrc, join(demoDir, 'sql-wasm.wasm'));
// The sql.js browser build (picked by bundlers via the "browser" export condition)
// requests the wasm under this alternative name.
if (existsSync(wasmBrowserSrc)) copyFileSync(wasmBrowserSrc, join(demoDir, 'sql-wasm-browser.wasm'));
console.log('copied srs.db and sql-wasm wasm files into demo/');
