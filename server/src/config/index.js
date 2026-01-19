/**
 * @fileoverview Configuration loader with validation.
 * Loads config.js from server root with hot-reload support.
 * @module config
 */

const path = require('path');
const Logger = require('../utils/logger');
const { DEFAULTS } = require('../constants/system');

/**
 * @typedef {import('../types/index').ApplicationConfiguration} ApplicationConfiguration
 * @typedef {import('../types/index').BotConfiguration} BotConfiguration
 */

/**
 * Default configuration values.
 * @type {Partial<ApplicationConfiguration>}
 */
const DEFAULT_CONFIGURATION = {
    behavior: {
        debounceSeconds: DEFAULTS.DEBOUNCE_SECONDS,
        userMessageFormat: '[{timestamp}]\n{message}',
        botMessageFilterRegex: '',
        messageSplitChar: '\n',
    },
    wssPort: DEFAULTS.WEBSOCKET_PORT,
    allowedUserIds: [],
    bots: [],
};

/**
 * Validates a single bot configuration.
 * @param {BotConfiguration} botConfiguration - Bot config to validate.
 * @param {number} index - Index in the bots array.
 * @returns {boolean} True if valid.
 */
function validateBotConfiguration(botConfiguration, index) {
    if (!botConfiguration.token || typeof botConfiguration.token !== 'string') {
        Logger.error(`Bot at index ${index} has invalid or missing token`);
        return false;
    }

    if (botConfiguration.token === 'YOUR_BOT_TOKEN_HERE' || 
        botConfiguration.token === 'YOUR_FIRST_BOT_TOKEN_HERE') {
        Logger.error(`Bot at index ${index} has default placeholder token`);
        return false;
    }

    if (!botConfiguration.characterName || typeof botConfiguration.characterName !== 'string') {
        Logger.error(`Bot at index ${index} has invalid or missing characterName`);
        return false;
    }

    return true;
}

/**
 * Validates the complete configuration object.
 * @param {ApplicationConfiguration} configuration - Configuration to validate.
 * @returns {boolean} True if valid.
 */
function validateConfiguration(configuration) {
    if (!configuration) {
        Logger.error('Configuration is null or undefined');
        return false;
    }

    if (!Array.isArray(configuration.bots)) {
        Logger.error('Configuration missing bots array');
        return false;
    }

    if (configuration.bots.length === 0) {
        Logger.error('Configuration has no bots defined');
        return false;
    }

    for (let index = 0; index < configuration.bots.length; index++) {
        if (!validateBotConfiguration(configuration.bots[index], index)) {
            return false;
        }
    }

    return true;
}

/**
 * Merges configuration with defaults.
 * @param {Partial<ApplicationConfiguration>} configuration - Loaded configuration.
 * @returns {ApplicationConfiguration} Merged configuration.
 */
function mergeWithDefaults(configuration) {
    return {
        behavior: {
            ...DEFAULT_CONFIGURATION.behavior,
            ...configuration.behavior,
        },
        wssPort: configuration.wssPort ?? DEFAULT_CONFIGURATION.wssPort,
        allowedUserIds: configuration.allowedUserIds ?? DEFAULT_CONFIGURATION.allowedUserIds,
        bots: configuration.bots ?? DEFAULT_CONFIGURATION.bots,
        summarization: configuration.summarization ?? null,
    };
}

/**
 * Applies environment variable overrides to configuration.
 * @param {ApplicationConfiguration} configuration - Base configuration.
 * @returns {ApplicationConfiguration} Configuration with env overrides.
 */
function applyEnvironmentOverrides(configuration) {
    const result = { ...configuration };

    if (process.env.WSS_PORT) {
        const port = parseInt(process.env.WSS_PORT, 10);
        if (!isNaN(port)) {
            result.wssPort = port;
        }
    }

    if (process.env.DEBOUNCE_SECONDS) {
        const seconds = parseInt(process.env.DEBOUNCE_SECONDS, 10);
        if (!isNaN(seconds)) {
            result.behavior = {
                ...result.behavior,
                debounceSeconds: seconds,
            };
        }
    }

    return result;
}

/**
 * Loads configuration from config.js file.
 * @param {string} [configPath] - Optional path to config file.
 * @returns {ApplicationConfiguration|null} Configuration object or null on failure.
 */
function loadConfiguration(configPath) {
    // Config is in server root (parent of src)
    const resolvedPath = configPath || path.resolve(__dirname, '../../config.js');

    // Clear require cache for hot-reload support
    delete require.cache[require.resolve(resolvedPath)];

    let rawConfiguration;
    try {
        rawConfiguration = require(resolvedPath);
    } catch (error) {
        if (error.code === 'MODULE_NOT_FOUND') {
            Logger.error(`Configuration file not found: ${resolvedPath}`);
            Logger.error('Please copy config.example.js to config.js and configure your bots');
        } else {
            Logger.error('Failed to load configuration:', error.message);
        }
        return null;
    }

    const mergedConfiguration = mergeWithDefaults(rawConfiguration);
    const finalConfiguration = applyEnvironmentOverrides(mergedConfiguration);

    if (!validateConfiguration(finalConfiguration)) {
        return null;
    }

    Logger.info(`Configuration loaded successfully with ${finalConfiguration.bots.length} bot(s)`);
    return finalConfiguration;
}

/**
 * Reloads configuration from disk.
 * @param {string} [configPath] - Optional path to config file.
 * @returns {ApplicationConfiguration|null} New configuration or null on failure.
 */
function reloadConfiguration(configPath) {
    Logger.info('Reloading configuration...');
    return loadConfiguration(configPath);
}

module.exports = {
    loadConfiguration,
    reloadConfiguration,
    validateConfiguration,
    DEFAULT_CONFIGURATION,
};
