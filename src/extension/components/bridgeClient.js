/**
 * @fileoverview Bridge Client for WebSocket communication with the server.
 * Handles connection management and message sending.
 * @module extension/components/bridgeClient
 */

/**
 * Event type constants for bridge client events.
 * @readonly
 * @enum {string}
 */
export const BRIDGE_EVENTS = Object.freeze({
    CONNECTED: 'connected',
    DISCONNECTED: 'disconnected',
    MESSAGE: 'message',
    ERROR: 'error',
});

/**
 * Connection status constants.
 * @readonly
 * @enum {string}
 */
export const CONNECTION_STATUS = Object.freeze({
    CONNECTED: 'connected',
    DISCONNECTED: 'disconnected',
    CONNECTING: 'connecting',
    ERROR: 'error',
});

/**
 * Bridge Client class for WebSocket communication.
 * @class
 */
class BridgeClient {
    /**
     * Creates a new BridgeClient instance.
     */
    constructor() {
        /** @type {WebSocket|null} */
        this._webSocket = null;

        /** @type {Map<string, Set<Function>>} */
        this._eventListeners = new Map();

        /** @type {string} */
        this._status = CONNECTION_STATUS.DISCONNECTED;
    }

    /**
     * Gets the current connection status.
     * @returns {string}
     */
    getStatus() {
        return this._status;
    }

    /**
     * Checks if the client is connected.
     * @returns {boolean}
     */
    isConnected() {
        return this._webSocket !== null && this._webSocket.readyState === WebSocket.OPEN;
    }

    /**
     * Adds an event listener.
     * @param {string} event - Event name.
     * @param {Function} callback - Event handler.
     */
    on(event, callback) {
        if (!this._eventListeners.has(event)) {
            this._eventListeners.set(event, new Set());
        }
        this._eventListeners.get(event).add(callback);
    }

    /**
     * Removes an event listener.
     * @param {string} event - Event name.
     * @param {Function} callback - Event handler to remove.
     */
    off(event, callback) {
        const listeners = this._eventListeners.get(event);
        if (listeners) {
            listeners.delete(callback);
        }
    }

    /**
     * Emits an event to all listeners.
     * @param {string} event - Event name.
     * @param {*} data - Event data.
     * @private
     */
    _emit(event, data) {
        const listeners = this._eventListeners.get(event);
        if (listeners) {
            for (const callback of listeners) {
                try {
                    callback(data);
                } catch (error) {
                    console.error('[Telegram Bridge] Event handler error:', error);
                }
            }
        }
    }

    /**
     * Connects to the bridge server.
     * @param {string} url - WebSocket URL.
     */
    connect(url) {
        if (this.isConnected()) {
            console.log('[Telegram Bridge] Already connected');
            return;
        }

        if (!url) {
            this._status = CONNECTION_STATUS.ERROR;
            this._emit(BRIDGE_EVENTS.ERROR, { message: 'URL not set!' });
            return;
        }

        this._status = CONNECTION_STATUS.CONNECTING;
        console.log(`[Telegram Bridge] Connecting to ${url}...`);

        try {
            this._webSocket = new WebSocket(url);

            this._webSocket.onopen = () => {
                console.log('[Telegram Bridge] Connection successful!');
                this._status = CONNECTION_STATUS.CONNECTED;
                this._emit(BRIDGE_EVENTS.CONNECTED, {});
            };

            this._webSocket.onmessage = (event) => {
                this._handleMessage(event);
            };

            this._webSocket.onclose = () => {
                console.log('[Telegram Bridge] Connection closed.');
                this._status = CONNECTION_STATUS.DISCONNECTED;
                this._webSocket = null;
                this._emit(BRIDGE_EVENTS.DISCONNECTED, {});
            };

            this._webSocket.onerror = (error) => {
                console.error('[Telegram Bridge] WebSocket error:', error);
                this._status = CONNECTION_STATUS.ERROR;
                this._webSocket = null;
                this._emit(BRIDGE_EVENTS.ERROR, { error });
            };
        } catch (error) {
            console.error('[Telegram Bridge] Connection error:', error);
            this._status = CONNECTION_STATUS.ERROR;
            this._webSocket = null;
            this._emit(BRIDGE_EVENTS.ERROR, { error });
        }
    }

    /**
     * Disconnects from the bridge server.
     */
    disconnect() {
        if (this._webSocket) {
            this._webSocket.close();
            this._webSocket = null;
        }
    }

    /**
     * Handles incoming WebSocket messages.
     * @param {MessageEvent} event - WebSocket message event.
     * @private
     */
    _handleMessage(event) {
        try {
            const data = JSON.parse(event.data);
            this._emit(BRIDGE_EVENTS.MESSAGE, data);
        } catch (error) {
            console.error('[Telegram Bridge] Failed to parse message:', error);
        }
    }

    /**
     * Sends a message to the server.
     * @param {string} type - Message type.
     * @param {Object} payload - Message payload.
     * @returns {boolean} True if sent successfully.
     */
    send(type, payload) {
        if (!this.isConnected()) {
            console.warn('[Telegram Bridge] Cannot send message: WebSocket not connected');
            return false;
        }

        try {
            const message = { type, ...payload };
            this._webSocket.send(JSON.stringify(message));
            return true;
        } catch (error) {
            console.error('[Telegram Bridge] Failed to send message:', error);
            return false;
        }
    }

    /**
     * Sends a typing action to the server.
     * @param {number} chatId - Telegram chat ID.
     * @param {string} botId - Bot identifier.
     */
    sendTypingAction(chatId, botId) {
        this.send('typing_action', { chatId, botId });
    }

    /**
     * Sends a chat action to the server.
     * @param {number} chatId - Telegram chat ID.
     * @param {string} botId - Bot identifier.
     * @param {string} action - Action type.
     */
    sendChatAction(chatId, botId, action) {
        this.send('chat_action', { chatId, botId, action });
    }

    /**
     * Sends a stream chunk to the server.
     * @param {number} chatId - Telegram chat ID.
     * @param {string} botId - Bot identifier.
     * @param {string} text - Chunk text.
     */
    sendStreamChunk(chatId, botId, text) {
        this.send('stream_chunk', { chatId, botId, text });
    }

    /**
     * Sends a stream end signal to the server.
     * @param {number} chatId - Telegram chat ID.
     * @param {string} botId - Bot identifier.
     */
    sendStreamEnd(chatId, botId) {
        this.send('stream_end', { chatId, botId });
    }

    /**
     * Sends a final message update to the server.
     * @param {number} chatId - Telegram chat ID.
     * @param {string} botId - Bot identifier.
     * @param {string} text - Final text.
     * @param {Array} [images] - Optional images array.
     */
    sendFinalMessageUpdate(chatId, botId, text, images) {
        this.send('final_message_update', {
            chatId,
            botId,
            text,
            images: images && images.length > 0 ? images : undefined,
        });
    }

    /**
     * Sends an AI reply to the server.
     * @param {number} chatId - Telegram chat ID.
     * @param {string} botId - Bot identifier.
     * @param {string} text - Reply text.
     * @param {Array} [images] - Optional images array.
     */
    sendAiReply(chatId, botId, text, images) {
        this.send('ai_reply', {
            chatId,
            botId,
            text,
            images: images && images.length > 0 ? images : undefined,
        });
    }

    /**
     * Sends an error message to the server.
     * @param {number} chatId - Telegram chat ID.
     * @param {string} botId - Bot identifier.
     * @param {string} text - Error message.
     */
    sendErrorMessage(chatId, botId, text) {
        this.send('error_message', { chatId, botId, text });
    }

    /**
     * Sends a command executed result to the server.
     * @param {Object} params - Command result parameters.
     */
    sendCommandExecuted(params) {
        this.send('command_executed', params);
    }
}

export default BridgeClient;
