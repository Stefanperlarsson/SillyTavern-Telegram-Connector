/**
 * @fileoverview System constants for commands and events.
 * All magic strings must be imported from this file.
 * @module constants/system
 */

/**
 * Command identifiers for bot commands.
 * @readonly
 * @enum {string}
 */
const COMMANDS = Object.freeze({
    RESTART: 'restart',
    RELOAD: 'reload',
    HELP: 'help',
    NEW: 'new',
    TRIGGER: 'trigger',
    SWITCH_MODEL: 'switchmodel',
    DELETE: 'delete',
    LIST_CHATS: 'listchats',
    SWITCH_CHAT: 'switchchat',
    SWITCH_CHARACTER: 'switchchar',
    PING: 'ping',
    EXIT: 'exit',
    HISTORY: 'history',
});

/**
 * Event type identifiers for WebSocket communication.
 * @readonly
 * @enum {string}
 */
const EVENTS = Object.freeze({
    STREAM_CHUNK: 'stream_chunk',
    STREAM_END: 'stream_end',
    FINAL_MESSAGE_UPDATE: 'final_message_update',
    AI_REPLY: 'ai_reply',
    ERROR_MESSAGE: 'error_message',
    TYPING_ACTION: 'typing_action',
    CHAT_ACTION: 'chat_action',
    COMMAND_EXECUTED: 'command_executed',
    USER_MESSAGE: 'user_message',
    EXECUTE_COMMAND: 'execute_command',
    HISTORY_FILE: 'history_file',
});

/**
 * Job type identifiers for queue processing.
 * @readonly
 * @enum {string}
 */
const JOB_TYPES = Object.freeze({
    MESSAGE: 'message',
    COMMAND: 'command',
});

/**
 * Connection status identifiers.
 * @readonly
 * @enum {string}
 */
const CONNECTION_STATUS = Object.freeze({
    CONNECTED: 'connected',
    DISCONNECTED: 'disconnected',
    CONNECTING: 'connecting',
    ERROR: 'error',
});

/**
 * Log level identifiers.
 * @readonly
 * @enum {string}
 */
const LOG_LEVELS = Object.freeze({
    INFO: 'INFO',
    WARN: 'WARN',
    ERROR: 'ERROR',
    DEBUG: 'DEBUG',
});

/**
 * Default configuration values.
 * @readonly
 * @enum {number|string}
 */
const DEFAULTS = Object.freeze({
    WEBSOCKET_PORT: 2333,
    DEBOUNCE_SECONDS: 10,
    MEDIA_GROUP_DELAY_MS: 500,
    STREAM_THROTTLE_MS: 2000,
    BRIDGE_URL: 'ws://127.0.0.1:2333',
});

module.exports = {
    COMMANDS,
    EVENTS,
    JOB_TYPES,
    CONNECTION_STATUS,
    LOG_LEVELS,
    DEFAULTS,
};
