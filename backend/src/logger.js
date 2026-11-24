// Central logging config (log4js). Everything in src/ logs through here — no console.log.
//
// Categories (= named loggers) decide WHERE a log line goes:
//   default      -> console + app file + errors file (ERROR and above)
//   api          -> requests file (JSON lines: incoming + completed per HTTP request) (+ errors file)
//   interaction  -> interactions file (JSON lines, one per chat turn: the AI trace)
//   feedback     -> feedback file (JSON lines, thumbs up/down from users)
import fs from 'node:fs';
import path from 'node:path';
import log4js from 'log4js';
import { loggingConfig } from './configs/index.js';

/** Folder for daily log files (configs/logging.config.js -> LOG_DIR). */
export const LOG_DIR = loggingConfig.dir;
fs.mkdirSync(LOG_DIR, { recursive: true });

// JSON layout: logger.info('message', { key: value }) -> {"ts":..., "level":..., "msg":"message", "key": value}
// Machine-readable lines are what make logs analyzable later (scripts/report.js reads them).
/**
 * Custom log4js layout "json": formats one log event as one JSON line.
 * The first string argument becomes `msg`; object arguments are merged in as fields; Errors become {error, stack}.
 * @returns {(e: import('log4js').LoggingEvent) => string}
 * @example logger.info('User feedback', { rating: 'down' })
 * // -> {"ts":"2026-11-24T05:45:53.501Z","level":"INFO","logger":"feedback","msg":"User feedback","rating":"down"}
 */
log4js.addLayout('json', () => (e) => {
  const [first, ...rest] = e.data;
  const msg = typeof first === 'string' ? first : undefined;
  const fields = Object.assign({}, ...[typeof first === 'object' ? first : null, ...rest]
    .filter((x) => x && typeof x === 'object')
    .map((x) => (x instanceof Error ? { error: x.message, stack: x.stack } : x)));
  return JSON.stringify({ ts: e.startTime.toISOString(), level: e.level.levelStr, logger: e.categoryName, ...(msg && { msg }), ...fields });
});

// Daily file (name.2026-11-24.log) that also rolls over by size (name.2026-11-24.1.log, ...).
// How MUCH is kept is decided by the total size budget below (enforceLogBudget), not by a day count.
/**
 * Build a log4js appender config: a new file per day, and a new numbered file whenever the current one
 * reaches LOG_MAX_FILE_MB. Old files are removed by {@link enforceLogBudget}.
 * @param {string} name                Base file name, e.g. "requests" -> logs/requests.2026-11-24.log
 * @param {object} [layout={type:'json'}]  log4js layout (JSON lines by default, or the readable pattern)
 * @returns {object} log4js "dateFile" appender config
 */
const daily = (name, layout = { type: 'json' }) => ({
  type: 'dateFile',
  filename: path.join(LOG_DIR, `${name}.log`),
  pattern: 'yyyy-MM-dd',
  keepFileExt: true,
  alwaysIncludePattern: true,
  maxLogSize: loggingConfig.maxFileMb * 1024 * 1024, // size rollover within a day
  numBackups: 1000, // effectively unlimited here — the total-size budget does the deleting
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
    default: { appenders: ['console', 'app', 'errors'], level: loggingConfig.level },
    api: { appenders: ['requests', 'errors'], level: 'info' }, // JSON only; app.log stays readable
    interaction: { appenders: ['interactions'], level: 'info' },
    feedback: { appenders: ['feedbackFile'], level: 'info' },
  },
});

/**
 * Get a named logger. The name appears in every line (`[agent]`) and selects the category:
 * "api", "interaction" and "feedback" write to their own files; any other name uses the default
 * (console + app log + errors log).
 * @param {string} name  e.g. "agent", "search", "server"
 * @returns {import('log4js').Logger}
 * @example const logger = getLogger('agent'); logger.info('hello');
 */
export const getLogger = (name) => log4js.getLogger(name);

/**
 * Flush all pending log writes and close files. Call before the process exits,
 * otherwise the last lines can be lost (log4js writes asynchronously).
 * @returns {Promise<void>}
 */
export const shutdownLogger = () => new Promise((resolve) => log4js.shutdown(resolve));

// ---------------------------------------------------------------------------
// Storage budget: the logs folder never grows beyond LOG_MAX_TOTAL_MB (default 30 MB).
// When it does, the OLDEST log files are deleted until it fits, so the newest logs are always kept.
// ---------------------------------------------------------------------------
const budgetLogger = log4js.getLogger('logs');

/**
 * Delete the oldest log files until the logs folder is within the size budget.
 * Files currently being written (the newest file of each log type) are never deleted.
 * Runs at startup and every LOG_CLEANUP_INTERVAL_MIN minutes.
 * @param {number} [maxBytes=loggingConfig.maxTotalMb MB]  Budget in bytes
 * @returns {{totalBytesBefore: number, totalBytesAfter: number, deleted: string[]}}
 * @example enforceLogBudget() // -> { totalBytesBefore: 33554432, totalBytesAfter: 29360128, deleted: ['app.2026-11-01.log'] }
 */
export function enforceLogBudget(maxBytes = loggingConfig.maxTotalMb * 1024 * 1024) {
  let files;
  try {
    files = fs.readdirSync(LOG_DIR)
      .filter((f) => /\.log(\.gz)?$/.test(f))
      .map((f) => {
        const st = fs.statSync(path.join(LOG_DIR, f));
        return { name: f, type: f.split('.')[0], size: st.size, mtime: st.mtimeMs };
      });
  } catch {
    return { totalBytesBefore: 0, totalBytesAfter: 0, deleted: [] };
  }

  const totalBytesBefore = files.reduce((s, f) => s + f.size, 0);
  let total = totalBytesBefore;
  const deleted = [];
  if (total > maxBytes) {
    // Protect the file each log type is writing to right now (its newest file)
    const active = new Set();
    for (const type of new Set(files.map((f) => f.type))) {
      const newest = files.filter((f) => f.type === type).sort((a, b) => b.mtime - a.mtime)[0];
      if (newest) active.add(newest.name);
    }
    // Oldest first, across all log types
    for (const f of files.filter((x) => !active.has(x.name)).sort((a, b) => a.mtime - b.mtime)) {
      if (total <= maxBytes) break;
      try {
        fs.unlinkSync(path.join(LOG_DIR, f.name));
        total -= f.size;
        deleted.push(f.name);
      } catch { /* locked (e.g. Windows) or already gone — try the next one */ }
    }
    const mb = (b) => (b / 1024 / 1024).toFixed(1);
    budgetLogger.info(`Log budget ${mb(maxBytes)} MB: ${mb(totalBytesBefore)} MB -> ${mb(total)} MB, deleted ${deleted.length} old file(s)`);
    if (total > maxBytes) budgetLogger.warn(`Logs still exceed the budget (${mb(total)} MB): only active files remain — lower LOG_MAX_FILE_MB`);
  }
  return { totalBytesBefore, totalBytesAfter: total, deleted };
}

enforceLogBudget(); // at startup
// Then periodically. unref(): this timer alone never keeps a script (eval, cli) running.
setInterval(enforceLogBudget, loggingConfig.cleanupIntervalMin * 60 * 1000).unref();

// ---------------------------------------------------------------------------
// Privacy: visitors type free text, so logs can contain personal data.
// Redact the obvious patterns before anything is written to disk.
// ---------------------------------------------------------------------------
/**
 * Mask personal data in free text before it is logged: emails, card-like numbers and
 * phone numbers (phones only WITH separators, so 10-digit product SKUs survive).
 * @param {*} text  Non-strings are returned unchanged
 * @returns {*} the redacted string
 * @example redact('mail john@example.com, SKU 1638637940') // -> 'mail [email], SKU 1638637940'
 */
export function redact(text) {
  if (typeof text !== 'string') return text;
  return text
    .replace(/[\w.+-]+@[\w-]+\.[\w.]+/g, '[email]')
    .replace(/\b(?:\d[ -]?){13,19}\b/g, '[card]')
    // Require separators: a bare 10-digit number is more likely a product SKU than a phone number
    .replace(/(\+\d{1,2}[\s.-]?)?\(?\d{3}\)?[\s.-]\d{3}[\s.-]\d{4}\b/g, '[phone]');
}

/**
 * Shorten long strings for logs, noting how much was cut.
 * @param {*} s            Non-strings are returned unchanged
 * @param {number} [n=500] Max characters to keep
 * @returns {*} e.g. "first 500 chars…[+1234 chars]"
 */
export const truncate = (s, n = 500) => (typeof s === 'string' && s.length > n ? `${s.slice(0, n)}…[+${s.length - n} chars]` : s);
