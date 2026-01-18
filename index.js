// index.js
// SillyTavern Telegram Connector Extension
// Handles communication between SillyTavern and the Telegram Bridge server

import {
    eventSource,
    event_types,
} from "../../../../script.js";

import { Logger } from './src/utils/logger.js';
import { EVENTS } from './src/constants/system.js';
import { webSocketService } from './src/services/webSocketService.js';
import { bridgeService } from './src/services/bridgeService.js';
import { settingsService } from './src/services/settingsService.js';

/**
 * Updates the connection status display in the UI
 * @param {string} message - Status message to display
 * @param {string} color - CSS color for the status text
 */
function updateStatus(message, color) {
    const statusElement = document.getElementById('telegram_connection_status');
    if (statusElement) {
        statusElement.textContent = `Status: ${message}`;
        statusElement.style.color = color;
    }
}

/**
 * Establishes a WebSocket connection based on settings
 */
function connect() {
    const settings = settingsService.getSettings();
    
    if (!settings.bridgeUrl) {
        updateStatus('URL not set!', 'red');
        return;
    }

    updateStatus('Connecting...', 'orange');
    
    webSocketService.onConnectHandler = () => {
        updateStatus('Connected', 'green');
    };

    webSocketService.onDisconnectHandler = () => {
        updateStatus('Disconnected', 'red');
    };

    webSocketService.onErrorHandler = () => {
        updateStatus('Connection error', 'red');
    };

    webSocketService.onMessageHandler = (data) => {
        bridgeService.handleMessage(data);
    };

    webSocketService.connect(settings.bridgeUrl);
}

// Register global event listeners
eventSource.on(event_types.GENERATION_ENDED, () => bridgeService.handleFinalMessage());
eventSource.on(event_types.GENERATION_STOPPED, () => bridgeService.handleFinalMessage());

// Register event listener for image generation start
eventSource.on('sd_prompt_processing', () => {
    if (bridgeService.activeRequest) {
        Logger.info('Image generation started, sending chat action to server');
        webSocketService.send({
            type: EVENTS.CHAT_ACTION,
            chatId: bridgeService.activeRequest.chatId,
            botId: bridgeService.activeRequest.botId,
            action: 'upload_photo'
        });
    }
});

// Initialization
jQuery(async () => {
    Logger.info('Loading SillyTavern Telegram Connector...');
    
    try {
        const moduleName = settingsService.getModuleName();
        const settingsHtml = await $.get(`/scripts/extensions/third-party/${moduleName}/settings.html`);
        $('#extensions_settings').append(settingsHtml);
        
        const settings = settingsService.getSettings();
        $('#telegram_bridge_url').val(settings.bridgeUrl);
        $('#telegram_auto_connect').prop('checked', settings.autoConnect);

        // UI Event Handlers
        $('#telegram_bridge_url').on('input', () => {
            settingsService.updateSettings({ bridgeUrl: $('#telegram_bridge_url').val() });
        });

        $('#telegram_auto_connect').on('change', () => {
            settingsService.updateSettings({ autoConnect: $('#telegram_auto_connect').is(':checked') });
        });

        $('#telegram_connect_button').on('click', () => connect());
        
        $('#telegram_disconnect_button').on('click', () => {
            webSocketService.disconnect();
        });

        // Auto-connect if enabled
        if (settings.autoConnect) {
            connect();
        }

        Logger.info('Extension initialized.');

    } catch (error) {
        Logger.error('Failed to initialize extension:', error);
    }
});
