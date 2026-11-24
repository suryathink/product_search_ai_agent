// Central logging config (log4js). Everything in src/ logs through here — no console.log.
//
// Categories (= named loggers) decide WHERE a log line goes:
//   default      -> console + app file + errors file (ERROR and above)
//   api          -> requests file (JSON lines: incoming + completed per HTTP request) (+ errors file)
//   interaction  -> interactions file (JSON lines, one per chat turn: the AI trace)
//   feedback     -> feedback file (JSON lines, thumbs up/down from users)
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import log4js from 'log4js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const LOG_DIR = process.env.LOG_DIR || path.resolve(__dirname, '../logs');
fs.mkdirSync(LOG_DIR, { recursive: true });

// JSON layout: logger.info('message', { key: value }) -> {"ts":..., "level":..., "msg":"message", "key": value}
// Machine-readable lines are what make logs analyzable later (scripts/report.js reads them).
log4js.addLayout('json', () => (e) => {
  const [first, ...rest] = e.data;
  const msg = typeof first === 'string' ? first : undefined;
  const fields = Object.assign({}, ...[typeof first === 'object' ? first : null, ...rest]
    .filter((x) => x && typeof x === 'object')
    .map((x) => (x instanceof Error ? { error: x.message, stack: x.stack } : x)));
  return JSON.stringify({ ts: e.startTime.toISOString(), level: e.level.levelStr, logger: e.categoryName, ...(msg && { msg }), ...fields });
});

// Daily rotated file: name.2026-11-24.log, keeps 14 days
const daily = (name, layout = { type: 'json' }) => ({
  type: 'dateFile',
  filename: path.join(LOG_DIR, `${name}.log`),
  pattern: 'yyyy-MM-dd',
  keepFileExt: true,
  alwaysIncludePattern: true,
  numBackups: 14,
  layout,
});

const readable = { type: 'pattern', pattern: '%d{yyyy-MM-dd hh:mm:ss.SSS} %-5p [%c] %m' };

log4js.configure({
  appenders: {
    console: { type: 'stdout', layout: { type: 'pattern', pattern: '%[%d{hh:mm:ss.SSS} %-5p [%c]%] %m' } },
    app: daily('app', readable),
    errorsFile: daily('errors', readable),
    errors: { type: 'logLevelFilter', appender: 'errorsFile', level: 'error' },
    requests: daily('requests'),
    interactions: daily('interactions'),
    feedbackFile: daily('feedback'),
  },
  categories: {
    default: { appenders: ['console', 'app', 'errors'], level: process.env.LOG_LEVEL || 'info' },
    api: { appenders: ['requests', 'errors'], level: 'info' }, // JSON only; app.log stays readable
    interaction: { appenders: ['interactions'], level: 'info' },
    feedback: { appenders: ['feedbackFile'], level: 'info' },
  },
});

/** Get a named logger, e.g. getLogger('agent'). Unknown names use the default category. */
export const getLogger = (name) => log4js.getLogger(name);

/** Flush files before exit (log4js writes asynchronously). */
export const shutdownLogger = () => new Promise((resolve) => log4js.shutdown(resolve));

// ---------------------------------------------------------------------------
// Privacy: visitors type free text, so logs can contain personal data.
// Redact the obvious patterns before anything is written to disk.
// ---------------------------------------------------------------------------
export function redact(text) {
  if (typeof text !== 'string') return text;
  return text
    .replace(/[\w.+-]+@[\w-]+\.[\w.]+/g, '[email]')
    .replace(/\b(?:\d[ -]?){13,19}\b/g, '[card]')
    // Require separators: a bare 10-digit number is more likely a product SKU than a phone number
    .replace(/(\+\d{1,2}[\s.-]?)?\(?\d{3}\)?[\s.-]\d{3}[\s.-]\d{4}\b/g, '[phone]');
}

export const truncate = (s, n = 500) => (typeof s === 'string' && s.length > n ? `${s.slice(0, n)}…[+${s.length - n} chars]` : s);
