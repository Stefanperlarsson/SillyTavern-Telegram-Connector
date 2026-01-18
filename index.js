/**
 * SillyTavern Telegram Connector Extension
 * 
 * Main entry point for the SillyTavern extension.
 * Handles communication between SillyTavern and the Telegram Bridge server.
 * Supports bot-per-character architecture with queued request processing.
 * 
 * @module index
 */

// ============================================================================
// SERVICES & UTILITIES
// ============================================================================

import { Logger } from './src/utils/logger.js';
import { settingsService } from './src/services/settingsService.js';
import { webSocketService } from './src/services/webSocketService.js';
import { bridgeService } from './src/services/bridgeService.js';

// ============================================================================
// UI FUNCTIONS
// ============================================================================

/**
 * Updates the connection status display in the UI
 * @param {string} message - Status message to display
 * @param {string} color - CSS color for the status text
 */
function updateStatusUI(message, color) {
    const statusEl = document.getElementById('telegram_connection_status');
    if (statusEl) {
        statusEl.textContent = `Status: ${message}`;
        statusEl.style.color = color;
    }
}

/**
 * Connects to the bridge server using settings
 */
function connect() {
    const settings = settingsService.getSettings();
    webSocketService.connect(settings.bridgeUrl);
}

/**
 * Disconnects from the bridge server
 */
function disconnect() {
    webSocketService.disconnect();
}

// ============================================================================
// EXTENSION INITIALIZATION
// ============================================================================

jQuery(async () => {
    Logger.info('Loading settings UI...');
    
    try {
        const moduleName = settingsService.getModuleName();
        const settingsHtml = await $.get(`/scripts/extensions/third-party/${moduleName}/settings.html`);
        $('#extensions_settings').append(settingsHtml);
        Logger.info('Settings UI loaded.');

        const settings = settingsService.getSettings();
        
        // Populate UI with current settings
        $('#telegram_bridge_url').val(settings.bridgeUrl);
        $('#telegram_auto_connect').prop('checked', settings.autoConnect);

        // Bridge URL input handler
        $('#telegram_bridge_url').on('input', function() {
            settingsService.setBridgeUrl($(this).val());
        });

        // Auto-connect checkbox handler
        $('#telegram_auto_connect').on('change', function() {
            const enabled = $(this).prop('checked');
            settingsService.setAutoConnect(enabled);
            Logger.info(`Auto-connect setting changed to: ${enabled}`);
        });

        // Button handlers
        $('#telegram_connect_button').on('click', connect);
        $('#telegram_disconnect_button').on('click', disconnect);

        // Wire up WebSocket service
        webSocketService.setStatusChangeHandler(updateStatusUI);
        webSocketService.onMessageHandler = (data) => bridgeService.handleMessage(data);
        webSocketService.onDisconnectHandler = () => {
            // Clear any active request on disconnect
            bridgeService.activeRequest = null;
        };

        // Initialize the bridge service (registers event listeners)
        bridgeService.initialize();

        // Auto-connect if enabled
        if (settings.autoConnect) {
            Logger.info('Auto-connect enabled, connecting...');
            connect();
        }

    } catch (error) {
        Logger.error('Failed to load settings HTML:', error);
    }
    
    Logger.info('Extension loaded.');
});
