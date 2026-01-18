/**
 * @fileoverview WebSocket Service for SillyTavern communication.
 * Handles raw socket events, message routing, and streaming sessions.
 * @module services/webSocketService
 */

const WebSocket = require('ws');
const Logger = require('../utils/logger');
const { EVENTS, DEFAULTS } = require('../constants/system');
const QueueManager = require('./queueManager');

/**
 * @typedef {import('../types/index').ManagedBot} ManagedBot
 * @typedef {import('../types/index').StreamSession} StreamSession
 */

/**
 * Callback for handling bot lookup.
 * @callback BotLookup
 * @param {string} botId - The bot ID to look up.
 * @returns {ManagedBot|undefined}
 */

/**
 * Callback for sending messages to Telegram.
 * @callback TelegramSender
 * @param {ManagedBot} managedBot - The bot to send through.
 * @param {number} chatId - The chat ID.
 * @param {string} text - The message text.
 * @returns {Promise<void>}
 */

/**
 * Callback for sending images to Telegram.
 * @callback ImageSender
 * @param {ManagedBot} managedBot - The bot to send through.
 * @param {number} chatId - The chat ID.
 * @param {Array<{base64: string, mimeType: string}>} images - Images to send.
 * @returns {Promise<void>}
 */

/**
 * WebSocket Service singleton for managing SillyTavern connection.
 * @class
 */
class WebSocketService {
    /**
     * Singleton instance.
     * @type {WebSocketService|null}
     * @private
     */
    static _instance = null;

    /**
     * Gets the singleton instance.
     * @returns {WebSocketService}
     */
    static getInstance() {
        if (!WebSocketService._instance) {
            WebSocketService._instance = new WebSocketService();
        }
        return WebSocketService._instance;
    }

    /**
     * Creates a new WebSocketService instance.
     * @private
     */
    constructor() {
        /** @type {WebSocket.Server|null} */
        this._server = null;

        /** @type {WebSocket|null} */
        this._client = null;

        /** @type {Map<string, StreamSession>} */
        this._ongoingStreams = new Map();

        /** @type {Map<string, NodeJS.Timeout>} */
        this._activeChatActions = new Map();

        /** @type {BotLookup|null} */
        this._botLookup = null;

        /** @type {TelegramSender|null} */
        this._telegramSender = null;

        /** @type {ImageSender|null} */
        this._imageSender = null;

        /** @type {Function|null} */
        this._messageSplitter = null;

        /** @type {Function|null} */
        this._messageSanitizer = null;

        /** @type {number} */
        this._streamThrottleMilliseconds = DEFAULTS.STREAM_THROTTLE_MS;
    }

    /**
     * Configures the WebSocket service.
     * @param {Object} options - Configuration options.
     * @param {BotLookup} options.botLookup - Function to look up bots by ID.
     * @param {TelegramSender} options.telegramSender - Function to send messages.
     * @param {ImageSender} options.imageSender - Function to send images.
     * @param {Function} [options.messageSplitter] - Function to get split character.
     * @param {Function} [options.messageSanitizer] - Function to sanitize messages.
     */
    configure(options) {
        if (options.botLookup) {
            this._botLookup = options.botLookup;
        }
        if (options.telegramSender) {
            this._telegramSender = options.telegramSender;
        }
        if (options.imageSender) {
            this._imageSender = options.imageSender;
        }
        if (options.messageSplitter) {
            this._messageSplitter = options.messageSplitter;
        }
        if (options.messageSanitizer) {
            this._messageSanitizer = options.messageSanitizer;
        }
    }

    /**
     * Generates a unique stream key for bot/chat combination.
     * @param {string} botId - Bot identifier.
     * @param {number} chatId - Chat identifier.
     * @returns {string} Unique stream key.
     * @private
     */
    _getStreamKey(botId, chatId) {
        return `${botId}_${chatId}`;
    }

    /**
     * Initializes the WebSocket server.
     * @param {number} port - Port to listen on.
     * @returns {Promise<void>}
     */
    initialize(port) {
        return new Promise((resolve, reject) => {
            try {
                this._server = new WebSocket.Server({ port });
                Logger.info(`WebSocket server listening on port ${port}...`);

                this._server.on('connection', (webSocket) => {
                    this._handleConnection(webSocket);
                });

                this._server.on('error', (error) => {
                    Logger.error('WebSocket server error:', error.message);
                    reject(error);
                });

                resolve();
            } catch (error) {
                Logger.error('Failed to initialize WebSocket server:', error.message);
                reject(error);
            }
        });
    }

    /**
     * Handles a new WebSocket connection.
     * @param {WebSocket} webSocket - The connected WebSocket.
     * @private
     */
    _handleConnection(webSocket) {
        Logger.info('SillyTavern extension connected!');
        this._client = webSocket;

        webSocket.on('message', async (message) => {
            await this._handleMessage(message);
        });

        webSocket.on('close', () => {
            Logger.info('SillyTavern extension disconnected.');
            this._client = null;
            this._cleanupStreams();
            QueueManager.getInstance().handleDisconnect();
        });

        webSocket.on('error', (error) => {
            Logger.error('WebSocket error occurred:', error.message);
            this._client = null;
            this._cleanupStreams();
            QueueManager.getInstance().handleDisconnect();
        });
    }

    /**
     * Cleans up all active streams and chat actions.
     * @private
     */
    _cleanupStreams() {
        this._ongoingStreams.clear();
        for (const intervalId of this._activeChatActions.values()) {
            clearInterval(intervalId);
        }
        this._activeChatActions.clear();
    }

    /**
     * Handles an incoming WebSocket message.
     * @param {Buffer|string} rawMessage - The raw message data.
     * @private
     */
    async _handleMessage(rawMessage) {
        let data;
        try {
            data = JSON.parse(rawMessage.toString());

            // Sanitize bot output if configured
            if (this._messageSanitizer && data.text) {
                const isOutputMessage = data.type === EVENTS.STREAM_CHUNK ||
                    data.type === EVENTS.FINAL_MESSAGE_UPDATE ||
                    data.type === EVENTS.AI_REPLY;
                if (isOutputMessage) {
                    data.text = this._messageSanitizer(data.text);
                }
            }

            await this._routeMessage(data);
        } catch (error) {
            Logger.error('Error processing SillyTavern message:', error.message);
            if (data && data.chatId && data.botId) {
                const streamKey = this._getStreamKey(data.botId, data.chatId);
                this._ongoingStreams.delete(streamKey);
            }
            QueueManager.getInstance().releaseJob();
        }
    }

    /**
     * Routes a parsed message to the appropriate handler.
     * @param {Object} data - Parsed message data.
     * @private
     */
    async _routeMessage(data) {
        const queueManager = QueueManager.getInstance();
        const activeJob = queueManager.getActiveJob();

        switch (data.type) {
            case EVENTS.COMMAND_EXECUTED:
                await this._handleCommandExecuted(data, activeJob);
                break;

            case EVENTS.STREAM_CHUNK:
                await this._handleStreamChunk(data);
                break;

            case EVENTS.STREAM_END:
                this._handleStreamEnd(data);
                break;

            case EVENTS.FINAL_MESSAGE_UPDATE:
                await this._handleFinalMessageUpdate(data);
                break;

            case EVENTS.AI_REPLY:
                await this._handleAiReply(data);
                break;

            case EVENTS.ERROR_MESSAGE:
                await this._handleErrorMessage(data);
                break;

            case EVENTS.TYPING_ACTION:
                this._handleTypingAction(data);
                break;

            case EVENTS.CHAT_ACTION:
                this._handleChatAction(data);
                break;

            case EVENTS.HISTORY_FILE:
                await this._handleHistoryFile(data);
                break;

            default:
                Logger.debug(`Unknown message type: ${data.type}`);
        }
    }

    /**
     * Handles command execution results.
     * @param {Object} data - Command execution data.
     * @param {import('../types/index').ActiveJob|null} activeJob - Current active job.
     * @private
     */
    async _handleCommandExecuted(data, activeJob) {
        const queueManager = QueueManager.getInstance();
        const isPendingSwitch = activeJob && activeJob.switchResolve;
        const isSwitchResponse = data.isQueuedSwitch ||
            (isPendingSwitch && (data.command === 'switchchar' || data.command === 'switchmodel'));

        if (isSwitchResponse) {
            if (activeJob && activeJob.switchResolve) {
                if (data.success) {
                    Logger.info(`Command "${data.command}" successful`);
                    if (data.command === 'switchchar') {
                        queueManager.confirmCharacterSwitch();
                    } else {
                        activeJob.switchResolve();
                    }
                } else {
                    Logger.error(`Command "${data.command}" failed: ${data.message}`);
                    const managedBot = this._botLookup?.(activeJob.job.managedBot.id);
                    if (managedBot && this._telegramSender) {
                        await this._telegramSender(
                            managedBot,
                            activeJob.job.chatId,
                            `Failed to execute ${data.command}: ${data.message}`
                        );
                    }
                    queueManager.rejectCharacterSwitch(new Error(data.message || 'Switch failed'));
                    queueManager.releaseJob();
                }
            }
            return;
        }

        // Non-switch command result
        Logger.info(`Command ${data.command} execution completed: ${data.success ? 'success' : 'failure'}`);

        if (activeJob && data.botId === activeJob.job.managedBot.id) {
            if (data.message) {
                const managedBot = this._botLookup?.(data.botId);
                if (managedBot && this._telegramSender) {
                    await this._telegramSender(managedBot, activeJob.job.chatId, data.message);
                }
            }
            queueManager.releaseJob();
        }
    }

    /**
     * Handles streaming text chunks.
     * @param {Object} data - Stream chunk data.
     * @private
     */
    async _handleStreamChunk(data) {
        if (!data.chatId || !data.botId) {
            return;
        }

        const streamKey = this._getStreamKey(data.botId, data.chatId);
        const managedBot = this._botLookup?.(data.botId);

        if (!managedBot) {
            Logger.error(`Received stream_chunk for unknown bot: ${data.botId}`);
            return;
        }

        let session = this._ongoingStreams.get(streamKey);

        if (!session) {
            let resolveMessagePromise;
            const messagePromise = new Promise((resolve) => {
                resolveMessagePromise = resolve;
            });

            session = {
                messagePromise: messagePromise,
                lastText: data.text,
                timer: null,
                isEditing: false,
            };
            this._ongoingStreams.set(streamKey, session);

            managedBot.instance.sendMessage(data.chatId, 'Thinking...')
                .then((sentMessage) => {
                    resolveMessagePromise(sentMessage.message_id);
                })
                .catch((error) => {
                    Logger.error('Failed to send initial streaming message:', error.message);
                    this._ongoingStreams.delete(streamKey);
                });
        } else {
            session.lastText = data.text;
        }

        // Throttled edit
        const messageId = await session.messagePromise;

        if (messageId && !session.isEditing && !session.timer) {
            session.timer = setTimeout(async () => {
                const currentSession = this._ongoingStreams.get(streamKey);
                if (!currentSession) {
                    return;
                }

                const currentMessageId = await currentSession.messagePromise;
                if (!currentMessageId) {
                    return;
                }

                currentSession.isEditing = true;
                const splitChar = this._messageSplitter?.() || '';
                const firstPart = splitChar
                    ? currentSession.lastText.split(splitChar)[0]
                    : currentSession.lastText;

                managedBot.instance.editMessageText(firstPart + ' ...', {
                    chat_id: data.chatId,
                    message_id: currentMessageId,
                }).catch((error) => {
                    if (!error.message.includes('message is not modified')) {
                        Logger.error('Failed to edit streaming message:', error.message);
                    }
                }).finally(() => {
                    if (this._ongoingStreams.has(streamKey)) {
                        this._ongoingStreams.get(streamKey).isEditing = false;
                    }
                });

                currentSession.timer = null;
            }, this._streamThrottleMilliseconds);
        }
    }

    /**
     * Handles stream end signal.
     * @param {Object} data - Stream end data.
     * @private
     */
    _handleStreamEnd(data) {
        if (!data.chatId || !data.botId) {
            return;
        }

        const streamKey = this._getStreamKey(data.botId, data.chatId);
        const session = this._ongoingStreams.get(streamKey);

        if (session) {
            if (session.timer) {
                clearTimeout(session.timer);
            }
            Logger.info('Stream end signal received, waiting for final update...');
        } else {
            Logger.warn(`Received stream_end but no session found for ${streamKey}`);
        }
    }

    /**
     * Handles final message update.
     * @param {Object} data - Final message data.
     * @private
     */
    async _handleFinalMessageUpdate(data) {
        if (!data.chatId || !data.botId) {
            return;
        }

        const streamKey = this._getStreamKey(data.botId, data.chatId);
        const managedBot = this._botLookup?.(data.botId);
        const session = this._ongoingStreams.get(streamKey);

        if (!managedBot) {
            Logger.error(`Received final_message_update for unknown bot: ${data.botId}`);
            return;
        }

        // Send images first
        if (data.images && data.images.length > 0 && this._imageSender) {
            Logger.info(`Sending ${data.images.length} image(s) to Telegram`);
            await this._imageSender(managedBot, data.chatId, data.images);
        }

        // Split message
        const splitChar = this._messageSplitter?.() || '';
        const parts = splitChar ? data.text.split(splitChar) : [data.text];

        // Find first non-empty part
        let anchorIndex = -1;
        for (let i = 0; i < parts.length; i++) {
            if (parts[i].trim().length > 0) {
                anchorIndex = i;
                break;
            }
        }

        if (session) {
            const messageId = await session.messagePromise;
            if (messageId && anchorIndex !== -1) {
                Logger.info(`Sending final streamed message update (Anchor: part ${anchorIndex})`);
                await managedBot.instance.editMessageText(parts[anchorIndex], {
                    chat_id: data.chatId,
                    message_id: messageId,
                }).catch((error) => {
                    if (!error.message.includes('message is not modified')) {
                        Logger.error('Failed to edit final message:', error.message);
                    }
                });
            } else if (anchorIndex === -1) {
                Logger.warn('Final response text is empty or whitespace only.');
            }
            this._ongoingStreams.delete(streamKey);
            Logger.info(`Streaming session ${streamKey} completed`);
        } else if (anchorIndex !== -1) {
            Logger.info('Sending non-streaming reply (Anchor)');
            await managedBot.instance.sendMessage(data.chatId, parts[anchorIndex])
                .catch((error) => Logger.error('Failed to send final message:', error.message));
        }

        // Send remaining parts
        if (anchorIndex !== -1) {
            for (let i = anchorIndex + 1; i < parts.length; i++) {
                if (parts[i].trim().length > 0) {
                    Logger.info(`Sending split message part ${i}`);
                    await managedBot.instance.sendMessage(data.chatId, parts[i])
                        .catch((error) => Logger.error('Failed to send split message:', error.message));
                }
            }
        }

        QueueManager.getInstance().releaseJob();
    }

    /**
     * Handles AI reply (non-streaming).
     * @param {Object} data - AI reply data.
     * @private
     */
    async _handleAiReply(data) {
        if (!data.chatId || !data.botId) {
            return;
        }

        const managedBot = this._botLookup?.(data.botId);
        if (!managedBot) {
            Logger.error(`Received ai_reply for unknown bot: ${data.botId}`);
            return;
        }

        // Send images first
        if (data.images && data.images.length > 0 && this._imageSender) {
            Logger.info(`Sending ${data.images.length} image(s) to Telegram`);
            await this._imageSender(managedBot, data.chatId, data.images);
        }

        // Split and send message
        const splitChar = this._messageSplitter?.() || '';
        const parts = splitChar ? data.text.split(splitChar) : [data.text];

        Logger.info(`Sending non-streaming AI reply${splitChar ? ' (split by configured char)' : ''}`);

        for (const part of parts) {
            if (part.trim().length > 0) {
                await managedBot.instance.sendMessage(data.chatId, part)
                    .catch((error) => Logger.error('Failed to send AI reply part:', error.message));
            }
        }

        QueueManager.getInstance().releaseJob();
    }

    /**
     * Handles error messages.
     * @param {Object} data - Error message data.
     * @private
     */
    async _handleErrorMessage(data) {
        if (!data.chatId || !data.botId) {
            return;
        }

        const managedBot = this._botLookup?.(data.botId);
        if (!managedBot) {
            Logger.error(`Received error_message for unknown bot: ${data.botId}`);
            return;
        }

        Logger.error(`Error from SillyTavern: ${data.text}`);
        await managedBot.instance.sendMessage(data.chatId, data.text)
            .catch((error) => Logger.error('Failed to send error message:', error.message));

        QueueManager.getInstance().releaseJob();
    }

    /**
     * Handles typing action.
     * @param {Object} data - Typing action data.
     * @private
     */
    _handleTypingAction(data) {
        if (!data.chatId || !data.botId) {
            return;
        }

        const managedBot = this._botLookup?.(data.botId);
        if (managedBot) {
            managedBot.instance.sendChatAction(data.chatId, 'typing')
                .catch((error) => Logger.error('Failed to send typing action:', error.message));
        }
    }

    /**
     * Handles chat action with keep-alive.
     * @param {Object} data - Chat action data.
     * @private
     */
    _handleChatAction(data) {
        if (!data.chatId || !data.botId) {
            return;
        }

        const managedBot = this._botLookup?.(data.botId);
        if (!managedBot) {
            return;
        }

        const actionKey = this._getStreamKey(data.botId, data.chatId);

        // Clear existing interval
        if (this._activeChatActions.has(actionKey)) {
            clearInterval(this._activeChatActions.get(actionKey));
        }

        const sendAction = () => {
            managedBot.instance.sendChatAction(data.chatId, data.action || 'upload_photo')
                .catch((error) => {
                    Logger.error(`Failed to send chat action (${data.action}):`, error.message);
                    if (this._activeChatActions.has(actionKey)) {
                        clearInterval(this._activeChatActions.get(actionKey));
                        this._activeChatActions.delete(actionKey);
                    }
                });
        };

        // Send immediately and start interval
        sendAction();
        const intervalId = setInterval(sendAction, 4000);
        this._activeChatActions.set(actionKey, intervalId);
    }

    /**
     * Handles history file from SillyTavern.
     * @param {Object} data - History file data.
     * @private
     */
    async _handleHistoryFile(data) {
        if (!data.chatId || !data.botId || !data.fileData || !data.fileName) {
            Logger.error('Received history_file with missing required fields');
            return;
        }

        const managedBot = this._botLookup?.(data.botId);
        if (!managedBot) {
            Logger.error(`Received history_file for unknown bot: ${data.botId}`);
            return;
        }

        try {
            Logger.info(`Sending history file to chat ${data.chatId}: ${data.fileName}`);

            // Convert base64 to Buffer
            const fileBuffer = Buffer.from(data.fileData, 'base64');

            // Send as document
            await managedBot.instance.sendDocument(data.chatId, fileBuffer, {}, {
                filename: data.fileName,
                contentType: 'text/html',
            });

            Logger.info('History file sent successfully');
        } catch (error) {
            Logger.error(`Failed to send history file: ${error.message}`);
            await managedBot.instance.sendMessage(data.chatId, 'Failed to send chat history file.')
                .catch((err) => Logger.error('Failed to send error message:', err.message));
        }

        QueueManager.getInstance().releaseJob();
    }

    /**
     * Checks if SillyTavern is connected.
     * @returns {boolean} True if connected.
     */
    isConnected() {
        return this._client !== null && this._client.readyState === WebSocket.OPEN;
    }

    /**
     * Sends a payload to SillyTavern.
     * @param {Object} payload - The payload to send.
     * @returns {boolean} True if sent successfully.
     */
    sendToSillyTavern(payload) {
        if (!this.isConnected()) {
            Logger.warn('Cannot send to SillyTavern: not connected');
            return false;
        }

        try {
            this._client.send(JSON.stringify(payload));
            return true;
        } catch (error) {
            Logger.error('Failed to send to SillyTavern:', error.message);
            return false;
        }
    }

    /**
     * Clears chat action for a specific bot/chat.
     * @param {string} botId - Bot identifier.
     * @param {number} chatId - Chat identifier.
     */
    clearChatAction(botId, chatId) {
        const actionKey = this._getStreamKey(botId, chatId);
        if (this._activeChatActions.has(actionKey)) {
            Logger.debug(`Stopping active chat action for ${actionKey}`);
            clearInterval(this._activeChatActions.get(actionKey));
            this._activeChatActions.delete(actionKey);
        }
    }

    /**
     * Closes the WebSocket server.
     * @returns {Promise<void>}
     */
    close() {
        return new Promise((resolve) => {
            this._cleanupStreams();

            if (this._server) {
                this._server.close(() => {
                    Logger.info('WebSocket server closed');
                    this._server = null;
                    resolve();
                });
            } else {
                resolve();
            }
        });
    }

    /**
     * Resets the singleton instance (for testing).
     */
    static resetInstance() {
        WebSocketService._instance = null;
    }
}

module.exports = WebSocketService;
