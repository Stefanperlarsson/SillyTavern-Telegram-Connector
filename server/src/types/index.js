/**
 * @fileoverview JSDoc type definitions for the SillyTavern Telegram Connector.
 * This file contains all shared type definitions used across the server.
 * @module types
 */

/* eslint-disable no-unused-vars */

// =============================================================================
// Configuration Types
// =============================================================================

/**
 * Configuration for a single Telegram bot.
 * @typedef {Object} BotConfiguration
 * @property {string} token - The Telegram bot API token.
 * @property {string} characterName - The SillyTavern character name to use with this bot.
 * @property {string} [connectionProfile] - Optional connection profile name.
 * @property {string} [lorebookName] - Optional World Info book name for storing summaries.
 * @property {string} [lorebookEntry] - Optional World Info entry name for storing summaries.
 */

/**
 * Behavior configuration options.
 * @typedef {Object} BehaviorConfiguration
 * @property {number} debounceSeconds - Seconds to wait before processing batched messages.
 * @property {string} userMessageFormat - Format string for user message timestamps.
 * @property {string} [botMessageFilterRegex] - Regex pattern to filter bot messages.
 * @property {string} messageSplitChar - Character used to split long messages.
 */

/**
 * Application configuration object.
 * @typedef {Object} ApplicationConfiguration
 * @property {BehaviorConfiguration} behavior - Behavior settings.
 * @property {number} wssPort - WebSocket server port.
 * @property {number[]} allowedUserIds - Array of allowed Telegram user IDs.
 * @property {BotConfiguration[]} bots - Array of bot configurations.
 */

// =============================================================================
// Queue & Job Types
// =============================================================================

/**
 * File attachment from Telegram.
 * @typedef {Object} FileAttachment
 * @property {string} fileId - Telegram file ID.
 * @property {string} fileName - Original file name.
 * @property {string} mimeType - File MIME type.
 */

/**
 * A job in the processing queue.
 * @typedef {Object} QueueJob
 * @property {string} id - Unique job identifier.
 * @property {ManagedBot} managedBot - The bot instance handling this job.
 * @property {number} chatId - Telegram chat ID.
 * @property {number} userId - Telegram user ID.
 * @property {string} text - Message text content.
 * @property {string} targetCharacter - Target character name.
 * @property {string} type - Job type (message or command).
 * @property {string} [command] - Command name if type is command.
 * @property {string[]} [arguments] - Command arguments.
 * @property {FileAttachment[]} [files] - Attached files.
 * @property {Array} [messages] - Batched messages.
 * @property {number} timestamp - Job creation timestamp.
 */

/**
 * Currently active job with additional state.
 * @typedef {Object} ActiveJob
 * @property {QueueJob} job - The queue job.
 * @property {boolean} characterSwitched - Whether character switch is confirmed.
 * @property {AbortController} [abortController] - Abort controller for cancellation.
 * @property {Function} [switchResolve] - Promise resolve for character switch.
 * @property {Function} [switchReject] - Promise reject for character switch.
 */

// =============================================================================
// Bot Types
// =============================================================================

/**
 * A managed Telegram bot instance.
 * @typedef {Object} ManagedBot
 * @property {string} id - Bot ID extracted from token.
 * @property {import('node-telegram-bot-api')} instance - TelegramBot instance.
 * @property {string} characterName - Associated character name.
 * @property {string} token - Bot API token.
 * @property {string} [connectionProfile] - Optional connection profile.
 * @property {string} [lorebookName] - Optional World Info book name for storing summaries.
 * @property {string} [lorebookEntry] - Optional World Info entry name for storing summaries.
 */

// =============================================================================
// Streaming Types
// =============================================================================

/**
 * Active streaming session state.
 * @typedef {Object} StreamSession
 * @property {Promise<number>} messagePromise - Promise resolving to message ID.
 * @property {string} lastText - Last sent text content.
 * @property {NodeJS.Timeout|null} timer - Throttle timer reference.
 * @property {boolean} isEditing - Whether an edit is in progress.
 */

// =============================================================================
// WebSocket Message Types
// =============================================================================

/**
 * Base WebSocket message structure.
 * @typedef {Object} WebSocketMessage
 * @property {string} type - Message type from EVENTS constant.
 * @property {*} [payload] - Message payload (varies by type).
 */

module.exports = {};
