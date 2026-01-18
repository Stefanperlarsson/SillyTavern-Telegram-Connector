/**
 * @fileoverview Logger utility for consistent, timestamped logging.
 * All modules must use this Logger instead of console.log directly.
 * @module utils/logger
 */

const { LOG_LEVELS } = require('../constants/system');

/**
 * Formats a date object into a standardized timestamp string.
 * @param {Date} date - The date to format.
 * @returns {string} Formatted timestamp in YYYY-MM-DD HH:mm:ss format.
 */
function formatTimestamp(date) {
    const year = date.getFullYear();
    const month = String(date.getMonth() + 1).padStart(2, '0');
    const day = String(date.getDate()).padStart(2, '0');
    const hours = String(date.getHours()).padStart(2, '0');
    const minutes = String(date.getMinutes()).padStart(2, '0');
    const seconds = String(date.getSeconds()).padStart(2, '0');

    return `${year}-${month}-${day} ${hours}:${minutes}:${seconds}`;
}

/**
 * Static Logger class for application-wide logging.
 * Format: [YYYY-MM-DD HH:mm:ss] [LEVEL] Message
 * @class
 */
class Logger {
    /**
     * Whether debug logging is enabled.
     * @type {boolean}
     * @private
     */
    static debugEnabled = process.env.DEBUG === 'true';

    /**
     * Formats and outputs a log message.
     * @param {string} level - The log level.
     * @param {Array<*>} args - The arguments to log.
     * @private
     */
    static _log(level, args) {
        const timestamp = formatTimestamp(new Date());
        const prefix = `[${timestamp}] [${level}]`;
        const output = level === LOG_LEVELS.ERROR ? console.error : console.log;

        output(prefix, ...args);
    }

    /**
     * Logs an informational message.
     * @param {...*} args - The arguments to log.
     */
    static info(...args) {
        Logger._log(LOG_LEVELS.INFO, args);
    }

    /**
     * Logs a warning message.
     * @param {...*} args - The arguments to log.
     */
    static warn(...args) {
        Logger._log(LOG_LEVELS.WARN, args);
    }

    /**
     * Logs an error message.
     * @param {...*} args - The arguments to log.
     */
    static error(...args) {
        Logger._log(LOG_LEVELS.ERROR, args);
    }

    /**
     * Logs a debug message (only when DEBUG=true).
     * @param {...*} args - The arguments to log.
     */
    static debug(...args) {
        if (!Logger.debugEnabled) {
            return;
        }
        Logger._log(LOG_LEVELS.DEBUG, args);
    }

    /**
     * Enables or disables debug logging.
     * @param {boolean} enabled - Whether to enable debug logging.
     */
    static setDebugEnabled(enabled) {
        Logger.debugEnabled = enabled;
    }
}

module.exports = Logger;
