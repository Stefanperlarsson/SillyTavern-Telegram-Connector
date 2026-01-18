/**
 * Settings management service for the Telegram Connector extension
 * @module services/settingsService
 */

import { MODULE_NAME, DEFAULT_SETTINGS } from '../constants/index.js';

/**
 * Service for managing extension settings
 */
class SettingsService {
    constructor() {
        /** @type {Object|null} */
        this._settings = null;
    }

    /**
     * Lazily loads and returns the settings
     * @returns {Object} Extension settings
     */
    getSettings() {
        if (!this._settings) {
            this._settings = this._loadSettings();
        }
        return this._settings;
    }

    /**
     * Loads settings from SillyTavern's extension settings
     * @returns {Object} Settings object
     * @private
     */
    _loadSettings() {
        const { extensionSettings } = SillyTavern.getContext();
        if (!extensionSettings[MODULE_NAME]) {
            extensionSettings[MODULE_NAME] = { ...DEFAULT_SETTINGS };
        }
        return extensionSettings[MODULE_NAME];
    }

    /**
     * Saves the current settings
     */
    saveSettings() {
        const { saveSettingsDebounced } = SillyTavern.getContext();
        saveSettingsDebounced();
    }

    /**
     * Updates settings with new values and saves
     * @param {Object} newSettings - Partial settings to merge
     */
    updateSettings(newSettings) {
        const settings = this.getSettings();
        Object.assign(settings, newSettings);
        this.saveSettings();
    }

    /**
     * Gets the module name constant
     * @returns {string}
     */
    getModuleName() {
        return MODULE_NAME;
    }

    /**
     * Gets the bridge URL from settings
     * @returns {string}
     */
    getBridgeUrl() {
        return this.getSettings().bridgeUrl;
    }

    /**
     * Sets the bridge URL
     * @param {string} url - New bridge URL
     */
    setBridgeUrl(url) {
        this.updateSettings({ bridgeUrl: url });
    }

    /**
     * Gets the auto-connect setting
     * @returns {boolean}
     */
    isAutoConnectEnabled() {
        return this.getSettings().autoConnect;
    }

    /**
     * Sets the auto-connect setting
     * @param {boolean} enabled - Whether to auto-connect
     */
    setAutoConnect(enabled) {
        this.updateSettings({ autoConnect: enabled });
    }
}

export const settingsService = new SettingsService();
