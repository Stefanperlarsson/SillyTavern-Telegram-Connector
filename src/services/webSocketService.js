/**
 * WebSocket client service for SillyTavern extension
 * @module services/webSocketService
 */

import { Logger } from '../utils/logger.js';

/**
 * Connection status constants
 */
export const ConnectionStatus = {
    DISCONNECTED: 'Disconnected',
    CONNECTING: 'Connecting...',
    CONNECTED: 'Connected',
    ERROR: 'Connection error',
    URL_NOT_SET: 'URL not set!',
};

/**
 * Status colors for UI display
 */
export const StatusColors = {
    [ConnectionStatus.DISCONNECTED]: 'red',
    [ConnectionStatus.CONNECTING]: 'orange',
    [ConnectionStatus.CONNECTED]: 'green',
    [ConnectionStatus.ERROR]: 'red',
    [ConnectionStatus.URL_NOT_SET]: 'red',
};

/**
 * WebSocket client service for communicating with the Telegram bridge server
 */
class WebSocketService {
    constructor() {
        /** @type {WebSocket|null} */
        this.webSocket = null;
        /** @type {Function|null} */
        this.onMessageHandler = null;
        /** @type {Function|null} */
        this.onConnectHandler = null;
        /** @type {Function|null} */
        this.onDisconnectHandler = null;
        /** @type {Function|null} */
        this.onErrorHandler = null;
        /** @type {Function|null} */
        this.onStatusChangeHandler = null;
    }

    /**
     * Sets the status change callback for UI updates
     * @param {Function} callback - Called with (message, color) when status changes
     */
    setStatusChangeHandler(callback) {
        this.onStatusChangeHandler = callback;
    }

    /**
     * Updates the connection status and notifies listeners
     * @param {string} status - Status constant from ConnectionStatus
     */
    _updateStatus(status) {
        if (this.onStatusChangeHandler) {
            this.onStatusChangeHandler(status, StatusColors[status] || 'gray');
        }
    }

    /**
     * Connects to the WebSocket server
     * @param {string} url - The WebSocket URL
     */
    connect(url) {
        if (this.webSocket && (this.webSocket.readyState === WebSocket.OPEN || this.webSocket.readyState === WebSocket.CONNECTING)) {
            Logger.info('Already connected or connecting');
            return;
        }

        if (!url) {
            Logger.error('WebSocket URL is required');
            this._updateStatus(ConnectionStatus.URL_NOT_SET);
            return;
        }

        this._updateStatus(ConnectionStatus.CONNECTING);
        Logger.info(`Connecting to ${url}...`);

        try {
            this.webSocket = new WebSocket(url);

            this.webSocket.onopen = () => {
                Logger.info('WebSocket connection established');
                this._updateStatus(ConnectionStatus.CONNECTED);
                if (this.onConnectHandler) this.onConnectHandler();
            };

            this.webSocket.onmessage = (event) => {
                if (this.onMessageHandler) {
                    try {
                        const data = JSON.parse(event.data);
                        this.onMessageHandler(data);
                    } catch (error) {
                        Logger.error('Failed to parse WebSocket message:', error);
                    }
                }
            };

            this.webSocket.onclose = (event) => {
                Logger.info('WebSocket connection closed');
                this._updateStatus(ConnectionStatus.DISCONNECTED);
                if (this.onDisconnectHandler) this.onDisconnectHandler(event);
                this.webSocket = null;
            };

            this.webSocket.onerror = (error) => {
                Logger.error('WebSocket error:', error);
                this._updateStatus(ConnectionStatus.ERROR);
                if (this.onErrorHandler) this.onErrorHandler(error);
                this.webSocket = null;
            };
        } catch (error) {
            Logger.error('Failed to create WebSocket:', error);
            this._updateStatus(ConnectionStatus.ERROR);
        }
    }

    /**
     * Sends data to the WebSocket server
     * @param {Object} payload - The data to send
     * @returns {boolean} True if sent successfully
     */
    send(payload) {
        if (!this.isConnected()) {
            Logger.warn('Cannot send: WebSocket not connected');
            return false;
        }

        try {
            this.webSocket.send(JSON.stringify(payload));
            return true;
        } catch (error) {
            Logger.error('Failed to send WebSocket message:', error);
            return false;
        }
    }

    /**
     * Disconnects from the WebSocket server
     */
    disconnect() {
        if (this.webSocket) {
            this.webSocket.close();
            this.webSocket = null;
        }
    }

    /**
     * Checks if the WebSocket is connected
     * @returns {boolean}
     */
    isConnected() {
        return this.webSocket && this.webSocket.readyState === WebSocket.OPEN;
    }
}

export const webSocketService = new WebSocketService();
