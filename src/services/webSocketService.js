import { Logger } from '../utils/logger.js';

export class WebSocketService {
    constructor() {
        this.webSocket = null;
        this.onMessageHandler = null;
        this.onConnectHandler = null;
        this.onDisconnectHandler = null;
        this.onErrorHandler = null;
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
            return;
        }

        Logger.info(`Connecting to ${url}...`);
        try {
            this.webSocket = new WebSocket(url);

            this.webSocket.onopen = () => {
                Logger.info('WebSocket connection established');
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
                if (this.onDisconnectHandler) this.onDisconnectHandler(event);
                this.webSocket = null;
            };

            this.webSocket.onerror = (error) => {
                Logger.error('WebSocket error:', error);
                if (this.onErrorHandler) this.onErrorHandler(error);
            };
        } catch (error) {
            Logger.error('Failed to create WebSocket:', error);
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
