/**
 * Extension constants and configuration
 * @module constants
 */

export const MODULE_NAME = 'SillyTavern-Telegram-Connector';

export const DEFAULT_SETTINGS = {
    bridgeUrl: 'ws://127.0.0.1:2333',
    autoConnect: true,
};

/**
 * WebSocket message event types
 * Combined for both inbound and outbound communication
 */
export const EVENTS = {
    // Outbound (to server)
    TYPING_ACTION: 'typing_action',
    CHAT_ACTION: 'chat_action',
    STREAM_CHUNK: 'stream_chunk',
    STREAM_END: 'stream_end',
    FINAL_MESSAGE_UPDATE: 'final_message_update',
    AI_REPLY: 'ai_reply',
    ERROR_MESSAGE: 'error_message',
    COMMAND_EXECUTED: 'command_executed',
    // Inbound (from server)
    EXECUTE_COMMAND: 'execute_command',
    USER_MESSAGE: 'user_message',
};

/**
 * Command identifiers for execute_command messages
 */
export const COMMANDS = {
    SWITCH_CHAR: 'switchchar',
    NEW_CHAT: 'new',
    LIST_CHATS: 'listchats',
    SWITCH_CHAT: 'switchchat',
    DELETE_MESSAGES: 'delete_messages',
    TRIGGER_GENERATION: 'trigger_generation',
    SWITCH_MODEL: 'switchmodel',
    PING: 'ping',
    HELP: 'help',
};

/**
 * MIME type to file extension mapping
 */
export const MIME_EXTENSION_MAP = {
    'image/jpeg': 'jpg',
    'image/png': 'png',
    'image/gif': 'gif',
    'image/webp': 'webp',
    'video/mp4': 'mp4',
    'video/webm': 'webm',
    'audio/mpeg': 'mp3',
    'audio/ogg': 'ogg',
    'audio/wav': 'wav',
};
