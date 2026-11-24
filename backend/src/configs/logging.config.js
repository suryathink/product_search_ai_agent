// Logging settings (log4js).
import { bool, num, str } from './env.js';
import { paths } from './paths.js';

const maxTotalMb = num('LOG_MAX_TOTAL_MB', 30);

/**
 * @type {{level: string, dir: string, maxTotalMb: number, maxFileMb: number, cleanupIntervalMin: number, interactionFileLogs: boolean}}
 */
export const loggingConfig = {
  /** Console/app log level: trace | debug | info | warn | error. debug also logs every LLM step and tool call. Env: LOG_LEVEL */
  level: str('LOG_LEVEL', 'info'),
  /** Folder for daily log files. Env: LOG_DIR */
  dir: paths.logDir,
  /**
   * Storage budget for the WHOLE logs folder. When exceeded, the oldest log files are deleted until it fits,
   * so the server always keeps the most recent ~N MB of logs. Env: LOG_MAX_TOTAL_MB
   */
  maxTotalMb,
  /**
   * A single log file rolls over to a new numbered file (name.<date>.1.log, ...) at this size, so one busy day
   * can't create one huge file. Default: a tenth of the total budget (5 log types x 2 files fit comfortably). Env: LOG_MAX_FILE_MB
   */
  maxFileMb: num('LOG_MAX_FILE_MB', Math.max(1, Math.floor(maxTotalMb / 10))),
  /** How often the size budget is enforced while the server runs (also enforced at startup). Env: LOG_CLEANUP_INTERVAL_MIN */
  cleanupIntervalMin: num('LOG_CLEANUP_INTERVAL_MIN', 10),
  /**
   * Also write conversation CONTENT (interactions + feedback) to log files?
   * true for development; set false in production so conversations live only in MongoDB. Env: INTERACTION_FILE_LOGS
   */
  interactionFileLogs: bool('INTERACTION_FILE_LOGS', true),
};
