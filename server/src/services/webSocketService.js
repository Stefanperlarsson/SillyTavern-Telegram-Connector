const WebSocket = require('ws');
const Logger = require('../utils/logger');
const { EVENTS } = require('../constants/system');
const QueueManager = require('./queueManager');

class WebSocketService {
    constructor() {
        this.server = null;
        this.client = null;
    }

    initialize(port) {
        this.server = new WebSocket.Server({ port });
        Logger.info(`WebSocket server listening on port ${port}...`);

        this.server.on('connection', (socket) => this.handleConnection(socket));
    }

    handleConnection(socket) {
        Logger.info('SillyTavern extension connected!');
        this.client = socket;

        socket.on('message', (data) => this.handleMessage(data));
        socket.on('close', () => this.handleDisconnect());
        socket.on('error', (error) => Logger.error('WebSocket error:', error));
    }

    handleMessage(rawData) {
        try {
            const data = JSON.parse(rawData);
            
            // Handle specific events that update Queue state
            if (data.type === EVENTS.COMMAND_EXECUTED) {
                this.handleCommandExecuted(data);
                return;
            }

            if (data.type === EVENTS.AI_REPLY || data.type === EVENTS.FINAL_MESSAGE) {
                // Logic to forward to TelegramService would be emitted here
                // For now, we release the lock
                QueueManager.releaseJob();
            }

        } catch (error) {
            Logger.error('Error processing WebSocket message:', error);
        }
    }

    handleCommandExecuted(data) {
        const activeJob = QueueManager.getActiveJob();
        if (!activeJob) return;

        // If this was a character switch, confirm it
        if (data.command === 'switchchar' && data.success) {
            activeJob.characterSwitched = true;
        }
    }

    handleDisconnect() {
        Logger.warn('SillyTavern extension disconnected.');
        this.client = null;
        QueueManager.clearQueue();
    }

    sendToSillyTavern(payload) {
        if (!this.client || this.client.readyState !== WebSocket.OPEN) {
            Logger.warn('Cannot send to SillyTavern: Not connected');
            return false;
        }
        this.client.send(JSON.stringify(payload));
        return true;
    }

    close() {
        if (this.server) this.server.close();
    }
}

module.exports = new WebSocketService();
