/**
 * @fileoverview Telegram Service for managing bot instances and message handling.
 * Handles bot polling, message processing, commands, and media groups.
 * @module services/telegramService
 */

const TelegramBot = require('node-telegram-bot-api');
const Logger = require('../utils/logger');
const { COMMANDS, JOB_TYPES, DEFAULTS } = require('../constants/system');
const QueueManager = require('./queueManager');
const WebSocketService = require('./webSocketService');

/**
 * @typedef {import('../types/index').ManagedBot} ManagedBot
 * @typedef {import('../types/index').BotConfiguration} BotConfiguration
 * @typedef {import('../types/index').ApplicationConfiguration} ApplicationConfiguration
 * @typedef {import('../types/index').FileAttachment} FileAttachment
 * @typedef {import('../types/index').QueueJob} QueueJob
 */

/**
 * Media group buffer entry.
 * @typedef {Object} MediaGroupBuffer
 * @property {Object[]} messages - Buffered messages.
 * @property {NodeJS.Timeout|null} timer - Processing timer.
 * @property {ManagedBot} managedBot - Bot handling this group.
 * @property {number} chatId - Chat ID.
 * @property {number} userId - User ID.
 */

/**
 * Telegram Service singleton for managing bot instances.
 * @class
 */
class TelegramService {
    /**
     * Singleton instance.
     * @type {TelegramService|null}
     * @private
     */
    static _instance = null;

    /**
     * Gets the singleton instance.
     * @returns {TelegramService}
     */
    static getInstance() {
        if (!TelegramService._instance) {
            TelegramService._instance = new TelegramService();
        }
        return TelegramService._instance;
    }

    /**
     * Creates a new TelegramService instance.
     * @private
     */
    constructor() {
        /** @type {Map<string, ManagedBot>} */
        this._managedBots = new Map();

        /** @type {Map<string, MediaGroupBuffer>} */
        this._pendingMediaGroups = new Map();

        /** @type {ApplicationConfiguration|null} */
        this._configuration = null;

        /** @type {number} */
        this._mediaGroupDelayMilliseconds = DEFAULTS.MEDIA_GROUP_DELAY_MS;

        /** @type {Function|null} */
        this._onSystemCommand = null;
    }

    /**
     * Extracts bot ID from token.
     * @param {string} token - Bot API token.
     * @returns {string} Bot ID.
     * @private
     */
    _getBotIdFromToken(token) {
        return token.split(':')[0];
    }

    /**
     * Gets a unique key for a media group.
     * @param {string} botId - Bot identifier.
     * @param {number} chatId - Chat ID.
     * @param {string} mediaGroupId - Telegram media group ID.
     * @returns {string} Media group key.
     * @private
     */
    _getMediaGroupKey(botId, chatId, mediaGroupId) {
        return `${botId}_${chatId}_${mediaGroupId}`;
    }

    /**
     * Formats a Unix timestamp to a date string.
     * @param {number} unixTimestamp - Unix timestamp in seconds.
     * @returns {string} Formatted date string.
     * @private
     */
    _formatTimestamp(unixTimestamp) {
        const date = new Date(unixTimestamp * 1000);
        const year = date.getFullYear();
        const month = String(date.getMonth() + 1).padStart(2, '0');
        const day = String(date.getDate()).padStart(2, '0');
        const hours = String(date.getHours()).padStart(2, '0');
        const minutes = String(date.getMinutes()).padStart(2, '0');
        return `${year}-${month}-${day} ${hours}:${minutes}`;
    }

    /**
     * Extracts file attachments from a Telegram message.
     * @param {Object} message - Telegram message object.
     * @returns {FileAttachment[]} Array of file attachments.
     * @private
     */
    _extractFileAttachments(message) {
        const files = [];

        if (message.photo && message.photo.length > 0) {
            const photo = message.photo[message.photo.length - 1];
            files.push({
                fileId: photo.file_id,
                fileName: 'photo.jpg',
                mimeType: 'image/jpeg',
            });
            Logger.debug(`Found photo attachment: ${photo.file_id}`);
        }

        if (message.document) {
            files.push({
                fileId: message.document.file_id,
                fileName: message.document.file_name || 'document',
                mimeType: message.document.mime_type || 'application/octet-stream',
            });
            Logger.debug(`Found document attachment: ${message.document.file_name}`);
        }

        if (message.video) {
            files.push({
                fileId: message.video.file_id,
                fileName: message.video.file_name || 'video.mp4',
                mimeType: message.video.mime_type || 'video/mp4',
            });
        }

        if (message.audio) {
            files.push({
                fileId: message.audio.file_id,
                fileName: message.audio.file_name || 'audio.mp3',
                mimeType: message.audio.mime_type || 'audio/mpeg',
            });
        }

        if (message.voice) {
            files.push({
                fileId: message.voice.file_id,
                fileName: 'voice.ogg',
                mimeType: message.voice.mime_type || 'audio/ogg',
            });
        }

        if (message.video_note) {
            files.push({
                fileId: message.video_note.file_id,
                fileName: 'video_note.mp4',
                mimeType: 'video/mp4',
            });
        }

        if (message.sticker) {
            const isAnimated = message.sticker.is_animated;
            const isVideo = message.sticker.is_video;
            files.push({
                fileId: message.sticker.file_id,
                fileName: isVideo ? 'sticker.webm' : (isAnimated ? 'sticker.tgs' : 'sticker.webp'),
                mimeType: isVideo ? 'video/webm' : (isAnimated ? 'application/x-tgsticker' : 'image/webp'),
            });
        }

        return files;
    }

    /**
     * Downloads a file from Telegram and converts to base64.
     * @param {TelegramBot} botInstance - Bot instance.
     * @param {string} fileId - Telegram file ID.
     * @param {string} fileName - Original file name.
     * @param {string} mimeType - MIME type.
     * @returns {Promise<{base64: string, mimeType: string, fileName: string}|null>}
     */
    async downloadFile(botInstance, fileId, fileName, mimeType) {
        try {
            Logger.debug(`Downloading file from Telegram: ${fileName} (${mimeType})`);

            const fileLink = await botInstance.getFileLink(fileId);
            Logger.debug(`Got file link: ${fileLink}`);

            const response = await fetch(fileLink);
            if (!response.ok) {
                Logger.error(`Failed to fetch file: ${response.status} ${response.statusText}`);
                return null;
            }

            const arrayBuffer = await response.arrayBuffer();
            const buffer = Buffer.from(arrayBuffer);
            const base64 = buffer.toString('base64');

            Logger.debug(`Downloaded file: ${fileName}, size: ${buffer.length} bytes`);

            return { base64, mimeType, fileName };
        } catch (error) {
            Logger.error(`Error downloading file from Telegram: ${error.message}`);
            return null;
        }
    }

    /**
     * Sends images to a Telegram chat.
     * @param {ManagedBot} managedBot - The bot to send through.
     * @param {number} chatId - The chat ID.
     * @param {Array<{base64: string, mimeType: string}>} images - Images to send.
     * @returns {Promise<void>}
     */
    async sendImages(managedBot, chatId, images) {
        const extensionMap = {
            'image/png': 'png',
            'image/jpeg': 'jpg',
            'image/jpg': 'jpg',
            'image/gif': 'gif',
            'image/webp': 'webp',
        };

        for (const image of images) {
            try {
                const imageBuffer = Buffer.from(image.base64, 'base64');
                const extension = extensionMap[image.mimeType] || 'png';

                Logger.debug(`Sending image to Telegram: ${image.mimeType}, ${imageBuffer.length} bytes`);

                await managedBot.instance.sendPhoto(chatId, imageBuffer, {}, {
                    filename: `image.${extension}`,
                    contentType: image.mimeType,
                });

                Logger.debug('Image sent successfully');
            } catch (error) {
                Logger.error(`Failed to send image: ${error.message}`);
            }
        }
    }

    /**
     * Sends a message to a Telegram chat.
     * @param {ManagedBot} managedBot - The bot to send through.
     * @param {number} chatId - The chat ID.
     * @param {string} text - The message text.
     * @returns {Promise<void>}
     */
    async sendMessage(managedBot, chatId, text) {
        try {
            await managedBot.instance.sendMessage(chatId, text);
        } catch (error) {
            Logger.error('Failed to send message:', error.message);
        }
    }

    /**
     * Processes a completed media group into a single job.
     * @param {string} groupKey - The media group key.
     * @private
     */
    _processMediaGroup(groupKey) {
        const group = this._pendingMediaGroups.get(groupKey);
        if (!group) {
            return;
        }

        this._pendingMediaGroups.delete(groupKey);

        const allFiles = [];
        let caption = '';

        for (const message of group.messages) {
            const files = this._extractFileAttachments(message);
            allFiles.push(...files);

            if (!caption && message.caption) {
                caption = message.caption;

                if (this._configuration?.behavior?.userMessageFormat) {
                    const dateString = this._formatTimestamp(message.date);
                    const timestampPrefix = this._configuration.behavior.userMessageFormat.replace('{{date}}', dateString);
                    caption = timestampPrefix + caption;
                }
            }
        }

        if (!caption && this._configuration?.behavior?.userMessageFormat && group.messages.length > 0) {
            const firstMessage = group.messages[0];
            const dateString = this._formatTimestamp(firstMessage.date);
            caption = this._configuration.behavior.userMessageFormat.replace('{{date}}', dateString);
        }

        Logger.info(`Processing media group: ${group.messages.length} messages, ${allFiles.length} files`);

        QueueManager.getInstance().debounceMessage(
            group.managedBot,
            group.chatId,
            group.userId,
            caption,
            allFiles.length > 0 ? allFiles : undefined
        );
    }

    /**
     * Handles incoming message for a bot.
     * @param {ManagedBot} managedBot - The bot that received the message.
     * @param {Object} message - Telegram message object.
     * @private
     */
    _handleMessage(managedBot, message) {
        const chatId = message.chat.id;
        const userId = message.from.id;
        const username = message.from.username || 'N/A';

        // Check whitelist
        if (this._configuration?.allowedUserIds?.length > 0) {
            if (!this._configuration.allowedUserIds.includes(userId)) {
                Logger.info(`Rejected access from non-whitelisted user (Bot: ${managedBot.characterName}):\n  - User ID: ${userId}\n  - Username: @${username}`);
                managedBot.instance.sendMessage(chatId, 'Sorry, you are not authorized to use this bot.')
                    .catch((error) => Logger.error('Failed to send rejection message:', error.message));
                return;
            }
        }

        // Handle media groups
        if (message.media_group_id) {
            const groupKey = this._getMediaGroupKey(managedBot.id, chatId, message.media_group_id);

            let group = this._pendingMediaGroups.get(groupKey);
            if (!group) {
                group = {
                    messages: [],
                    timer: null,
                    managedBot: managedBot,
                    chatId: chatId,
                    userId: userId,
                };
                this._pendingMediaGroups.set(groupKey, group);
                Logger.debug(`Started collecting media group: ${message.media_group_id}`);
            }

            group.messages.push(message);
            Logger.debug(`Added message to media group ${message.media_group_id}, total: ${group.messages.length}`);

            if (group.timer) {
                clearTimeout(group.timer);
            }
            group.timer = setTimeout(() => {
                this._processMediaGroup(groupKey);
            }, this._mediaGroupDelayMilliseconds);

            return;
        }

        // Extract text
        let text = message.text || message.caption || '';
        const files = this._extractFileAttachments(message);

        Logger.info(`Received message for "${managedBot.characterName}" from user ${userId}: text="${text.substring(0, 50)}${text.length > 50 ? '...' : ''}", files=${files.length}`);

        if (!text && files.length === 0) {
            Logger.debug('Ignoring empty message');
            return;
        }

        // Handle commands (check BEFORE applying timestamp prefix)
        if (text.startsWith('/') && files.length === 0) {
            this._handleCommand(managedBot, message);
            return;
        }

        // Apply timestamp (only for regular messages, not commands)
        if (this._configuration?.behavior?.userMessageFormat) {
            const dateString = this._formatTimestamp(message.date);
            const timestampPrefix = this._configuration.behavior.userMessageFormat.replace('{{date}}', dateString);

            if (text || files.length > 0) {
                text = timestampPrefix + text;
            }
        }

        // Regular messages
        QueueManager.getInstance().debounceMessage(
            managedBot,
            chatId,
            userId,
            text,
            files.length > 0 ? files : undefined
        );
    }

    /**
     * Handles bot commands.
     * @param {ManagedBot} managedBot - The bot.
     * @param {Object} message - Telegram message.
     * @private
     */
    _handleCommand(managedBot, message) {
        const chatId = message.chat.id;
        const text = message.text;

        const parts = text.slice(1).trim().split(/\s+/);
        const command = parts[0].toLowerCase();
        const commandArguments = parts.slice(1);

        Logger.info(`Command received on bot "${managedBot.characterName}": /${command}`);

        // System commands
        if ([COMMANDS.RELOAD, COMMANDS.RESTART, COMMANDS.EXIT, COMMANDS.PING].includes(command)) {
            this._handleSystemCommand(command, chatId, managedBot);
            return;
        }

        // Help command
        if (command === COMMANDS.HELP) {
            this._sendHelpMessage(managedBot, chatId);
            return;
        }

        // Queued commands
        if ([COMMANDS.NEW, COMMANDS.LIST_CHATS, COMMANDS.HISTORY, COMMANDS.SUMMARIZE].includes(command) || command.match(/^switchchat_?\d*$/)) {
            this._enqueueCommand(managedBot, message, command, commandArguments);
            return;
        }

        // Delete command
        if (command === COMMANDS.DELETE) {
            const count = commandArguments.length > 0 ? parseInt(commandArguments[0]) : 1;
            if (isNaN(count) || count < 1) {
                managedBot.instance.sendMessage(chatId, 'Invalid number of messages to delete.')
                    .catch((error) => Logger.error('Failed to send error message:', error.message));
                return;
            }
            this._enqueueCommand(managedBot, message, 'delete_messages', [count]);
            return;
        }

        // Trigger command
        if (command === COMMANDS.TRIGGER) {
            this._enqueueCommand(managedBot, message, 'trigger_generation', []);
            return;
        }

        // Unknown command
        managedBot.instance.sendMessage(chatId, `Unknown command: /${command}. Use /help to see available commands.`)
            .catch((error) => Logger.error('Failed to send unknown command message:', error.message));
    }

    /**
     * Enqueues a command job.
     * @param {ManagedBot} managedBot - The bot.
     * @param {Object} message - Telegram message.
     * @param {string} command - Command name.
     * @param {Array} commandArguments - Command arguments.
     * @private
     */
    _enqueueCommand(managedBot, message, command, commandArguments) {
        /** @type {QueueJob} */
        const job = {
            id: '',
            managedBot: managedBot,
            chatId: message.chat.id,
            userId: message.from.id,
            text: '',
            targetCharacter: managedBot.characterName,
            type: JOB_TYPES.COMMAND,
            command: command,
            arguments: commandArguments,
            timestamp: 0,
        };

        QueueManager.getInstance().enqueueJob(job);
    }

    /**
     * Sends help message.
     * @param {ManagedBot} managedBot - The bot.
     * @param {number} chatId - Chat ID.
     * @private
     */
    _sendHelpMessage(managedBot, chatId) {
        const helpText = `${managedBot.characterName} - Telegram Bridge Commands:

Chat Management
/new - Start a new chat with ${managedBot.characterName}
/listchats - List all saved chat logs
/switchchat <name> - Load a specific chat log
/switchchat_<N> - Load chat log by number
/delete [n] - Delete the last n messages (default 1)
/trigger - Manually trigger a new AI response
/history - Export current chat history as HTML file

Memory & Summarization
/summarize - Summarize conversation, save to lorebook, start new chat

System Management
/reload - Reload server configuration
/restart - Restart server
/exit - Shutdown server
/ping - Check connection status

Help
/help - Show this help message`;

        managedBot.instance.sendMessage(chatId, helpText)
            .catch((error) => Logger.error('Failed to send help message:', error.message));
    }

    /**
     * Handles system commands.
     * @param {string} command - Command name.
     * @param {number} chatId - Chat ID.
     * @param {ManagedBot} managedBot - The bot.
     * @private
     */
    _handleSystemCommand(command, chatId, managedBot) {
        Logger.info(`Executing system command: ${command}`);

        if (command === COMMANDS.PING) {
            const webSocketService = WebSocketService.getInstance();
            const queueManager = QueueManager.getInstance();

            const bridgeStatus = 'Bridge status: Connected';
            const sillyTavernStatus = webSocketService.isConnected()
                ? 'SillyTavern status: Connected'
                : 'SillyTavern status: Not connected';
            const queueStatus = `Queue: ${queueManager.getQueueLength()} pending, ${queueManager.isProcessing() ? 'processing' : 'idle'}`;
            const botsStatus = `Active bots: ${this._managedBots.size}`;

            managedBot.instance.sendMessage(chatId, `${bridgeStatus}\n${sillyTavernStatus}\n${queueStatus}\n${botsStatus}`)
                .catch((error) => Logger.error('Failed to send ping response:', error.message));
            return;
        }

        if (this._onSystemCommand) {
            this._onSystemCommand(command, chatId, managedBot);
        }
    }

    /**
     * Sets the system command callback.
     * @param {Function} callback - Callback function.
     */
    onSystemCommand(callback) {
        this._onSystemCommand = callback;
    }

    /**
     * Sets up message handlers for a bot.
     * @param {ManagedBot} managedBot - The bot.
     * @private
     */
    _setupBotHandlers(managedBot) {
        managedBot.instance.on('message', (message) => {
            this._handleMessage(managedBot, message);
        });
    }

    /**
     * Clears pending updates and starts polling.
     * @returns {Promise<void>}
     * @private
     */
    async _clearAndStartPollingAll() {
        const isRestart = process.env.TELEGRAM_CLEAR_UPDATES === '1';

        for (const [botId, managedBot] of this._managedBots) {
            try {
                Logger.info(`Clearing message queue for bot "${managedBot.characterName}"...`);

                if (isRestart) {
                    let updates;
                    let lastUpdateId = 0;

                    do {
                        updates = await managedBot.instance.getUpdates({
                            offset: lastUpdateId,
                            limit: 100,
                            timeout: 0,
                        });

                        if (updates && updates.length > 0) {
                            lastUpdateId = updates[updates.length - 1].update_id + 1;
                        }
                    } while (updates && updates.length > 0);
                } else {
                    const updates = await managedBot.instance.getUpdates({ limit: 100, timeout: 0 });
                    if (updates && updates.length > 0) {
                        const lastUpdateId = updates[updates.length - 1].update_id;
                        await managedBot.instance.getUpdates({ offset: lastUpdateId + 1, limit: 1, timeout: 0 });
                        Logger.info(`Cleared ${updates.length} pending messages for bot "${managedBot.characterName}"`);
                    }
                }

                managedBot.instance.startPolling({ restart: true, clean: true });
                Logger.info(`Bot "${managedBot.characterName}" polling started`);
            } catch (error) {
                Logger.error(`Error starting bot "${managedBot.characterName}":`, error.message);
                managedBot.instance.startPolling({ restart: true, clean: true });
            }
        }

        if (isRestart) {
            delete process.env.TELEGRAM_CLEAR_UPDATES;
        }
    }

    /**
     * Initializes the Telegram service.
     * @param {ApplicationConfiguration} configuration - Configuration.
     * @returns {Promise<void>}
     */
    async initialize(configuration) {
        this._configuration = configuration;
        Logger.info(`Initializing ${configuration.bots.length} bot(s)...`);

        for (const botConfiguration of configuration.bots) {
            const botId = this._getBotIdFromToken(botConfiguration.token);
            const botInstance = new TelegramBot(botConfiguration.token, { polling: false });

            /** @type {ManagedBot} */
            const managedBot = {
                id: botId,
                instance: botInstance,
                characterName: botConfiguration.characterName,
                token: botConfiguration.token,
                connectionProfile: botConfiguration.connectionProfile,
                lorebookName: botConfiguration.lorebookName,
                lorebookEntry: botConfiguration.lorebookEntry,
            };

            this._managedBots.set(botId, managedBot);
            this._setupBotHandlers(managedBot);

            Logger.info(`Bot "${botConfiguration.characterName}" (ID: ${botId}) initialized`);
        }

        await this._clearAndStartPollingAll();
    }

    /**
     * Gets a bot by ID.
     * @param {string} botId - Bot ID.
     * @returns {ManagedBot|undefined}
     */
    getBot(botId) {
        return this._managedBots.get(botId);
    }

    /**
     * Gets all managed bots.
     * @returns {Map<string, ManagedBot>}
     */
    getAllBots() {
        return this._managedBots;
    }

    /**
     * Stops all bot polling.
     * @returns {Promise<void>}
     */
    async stopAll() {
        const stopPromises = [];
        for (const [botId, managedBot] of this._managedBots) {
            stopPromises.push(
                managedBot.instance.stopPolling().catch((error) => {
                    Logger.error(`Error stopping bot ${managedBot.characterName}:`, error.message);
                })
            );
        }
        await Promise.all(stopPromises);
        Logger.info('All bots stopped');
    }

    /**
     * Resets the singleton instance.
     */
    static resetInstance() {
        TelegramService._instance = null;
    }
}

module.exports = TelegramService;
