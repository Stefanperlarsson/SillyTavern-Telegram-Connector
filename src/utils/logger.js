/**
 * Standardized Logger complying with company style (Client-side)
 */
export class Logger {
    static getTimestamp() {
        const now = new Date();
        return now.toISOString().replace('T', ' ').substring(0, 19);
    }

    static info(...args) {
        console.log(`[${this.getTimestamp()}] [INFO]`, ...args);
    }

    static warn(...args) {
        console.warn(`[${this.getTimestamp()}] [WARN]`, ...args);
    }

    static error(...args) {
        console.error(`[${this.getTimestamp()}] [ERROR]`, ...args);
    }

    static debug(...args) {
        // SillyTavern usually has its own debug flag, but we can use a local one or extension settings
        console.debug(`[${this.getTimestamp()}] [DEBUG]`, ...args);
    }
}
