// Loads backend/.env exactly once and provides typed readers.
// Every config file imports this first, so no other module ever touches process.env directly.
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import dotenv from 'dotenv';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/** Absolute path of backend/.env (works no matter which folder the process was started from). */
export const ENV_FILE = path.resolve(__dirname, '../../.env');

// Values already set in the real environment win over .env (standard dotenv behaviour) —
// that's how tests/CI override settings without editing the file.
dotenv.config({ path: ENV_FILE, quiet: true });

/**
 * Read a string setting.
 * @param {string|string[]} names   Variable name, or several accepted aliases (first one set wins)
 * @param {string|null} [fallback=null]
 * @returns {string|null} trimmed value, or the fallback when unset/empty
 * @example str(['QDRANT_URL', 'QDRANT_HOST'])
 */
export function str(names, fallback = null) {
  for (const n of [names].flat()) {
    const v = process.env[n];
    if (v != null && String(v).trim() !== '') return String(v).trim();
  }
  return fallback;
}

/**
 * Read a numeric setting.
 * @param {string} name
 * @param {number} fallback  Used when unset or not a number
 * @returns {number}
 */
export function num(name, fallback) {
  const v = Number(str(name));
  return str(name) != null && Number.isFinite(v) ? v : fallback;
}

/**
 * Read a boolean setting ("true"/"1"/"yes" -> true, "false"/"0"/"no" -> false).
 * @param {string} name
 * @param {boolean} fallback  Used when unset or unrecognized
 * @returns {boolean}
 */
export function bool(name, fallback) {
  const v = (str(name) ?? '').toLowerCase();
  if (['true', '1', 'yes', 'on'].includes(v)) return true;
  if (['false', '0', 'no', 'off'].includes(v)) return false;
  return fallback;
}

/**
 * Read a `--name=value` command-line flag (cross-platform alternative to `VAR=x node ...`,
 * which doesn't work in Windows npm scripts).
 * @param {string} name  e.g. "vector-store"
 * @returns {string|undefined}
 * @example // node src/server.js --vector-store=local  ->  cliFlag('vector-store') === 'local'
 */
export function cliFlag(name) {
  return process.argv.find((a) => a.startsWith(`--${name}=`))?.split('=').slice(1).join('=');
}
