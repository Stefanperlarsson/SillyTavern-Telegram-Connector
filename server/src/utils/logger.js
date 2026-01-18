/**
 * Standardized Logger complying with company style
 */
class Logger {
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
        if (process.env.DEBUG === 'true') {
            console.debug(`[${this.getTimestamp()}] [DEBUG]`, ...args);
        }
    }
}

module.exports = Logger;
