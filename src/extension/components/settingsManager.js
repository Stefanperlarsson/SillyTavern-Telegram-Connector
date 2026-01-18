/**
 * @fileoverview Settings Manager for extension configuration.
 * Provides type-safe access to extension settings.
 * @module extension/components/settingsManager
 */

/**
 * Default settings values.
 * @readonly
 */
const DEFAULT_SETTINGS = Object.freeze({
    bridgeUrl: 'ws://127.0.0.1:2333',
    autoConnect: true,
});

/**
 * Settings Manager class for extension configuration.
 * @class
 */
class SettingsManager {
    /**
     * Creates a new SettingsManager instance.
     * @param {string} moduleName - Extension module name.
     * @param {Object} extensionSettings - SillyTavern extension settings object.
     * @param {Function} saveSettingsDebounced - Function to save settings.
     */
    constructor(moduleName, extensionSettings, saveSettingsDebounced) {
        /** @type {string} */
        this._moduleName = moduleName;

        /** @type {Object} */
        this._extensionSettings = extensionSettings;

        /** @type {Function} */
        this._saveSettingsDebounced = saveSettingsDebounced;

        this._initializeDefaults();
    }

    /**
     * Initializes settings with default values if not present.
     * @private
     */
    _initializeDefaults() {
        if (!this._extensionSettings[this._moduleName]) {
            this._extensionSettings[this._moduleName] = { ...DEFAULT_SETTINGS };
        }

        const settings = this._extensionSettings[this._moduleName];
        for (const [key, value] of Object.entries(DEFAULT_SETTINGS)) {
            if (settings[key] === undefined) {
                settings[key] = value;
            }
        }
    }

    /**
     * Gets all settings.
     * @returns {Object}
     */
    getSettings() {
        return this._extensionSettings[this._moduleName];
    }

    /**
     * Gets the bridge URL.
     * @returns {string}
     */
    getBridgeUrl() {
        return this.getSettings().bridgeUrl || DEFAULT_SETTINGS.bridgeUrl;
    }

    /**
     * Sets the bridge URL.
     * @param {string} url - New bridge URL.
     */
    setBridgeUrl(url) {
        this.getSettings().bridgeUrl = url;
        this._save();
    }

    /**
     * Gets the auto-connect setting.
     * @returns {boolean}
     */
    getAutoConnect() {
        const settings = this.getSettings();
        return settings.autoConnect !== undefined ? settings.autoConnect : DEFAULT_SETTINGS.autoConnect;
    }

    /**
     * Sets the auto-connect setting.
     * @param {boolean} enabled - Whether to auto-connect.
     */
    setAutoConnect(enabled) {
        this.getSettings().autoConnect = enabled;
        this._save();
    }

    /**
     * Saves settings using the debounced function.
     * @private
     */
    _save() {
        if (this._saveSettingsDebounced) {
            this._saveSettingsDebounced();
        }
    }

    /**
     * Resets settings to defaults.
     */
    resetToDefaults() {
        this._extensionSettings[this._moduleName] = { ...DEFAULT_SETTINGS };
        this._save();
    }
}

export { DEFAULT_SETTINGS };
export default SettingsManager;
