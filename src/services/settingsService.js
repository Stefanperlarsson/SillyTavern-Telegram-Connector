const MODULE_NAME = 'SillyTavern-Telegram-Connector';
const DEFAULT_SETTINGS = {
    bridgeUrl: 'ws://127.0.0.1:2333',
    autoConnect: true,
};

export class SettingsService {
    constructor() {
        this.settings = this.loadSettings();
    }

    loadSettings() {
        const { extensionSettings } = SillyTavern.getContext();
        if (!extensionSettings[MODULE_NAME]) {
            extensionSettings[MODULE_NAME] = { ...DEFAULT_SETTINGS };
        }
        return extensionSettings[MODULE_NAME];
    }

    getSettings() {
        return this.settings;
    }

    saveSettings() {
        const { saveSettingsDebounced } = SillyTavern.getContext();
        saveSettingsDebounced();
    }

    updateSettings(newSettings) {
        Object.assign(this.settings, newSettings);
        this.saveSettings();
    }

    getModuleName() {
        return MODULE_NAME;
    }
}

export const settingsService = new SettingsService();
