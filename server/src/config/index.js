const fs = require('fs');
const path = require('path');
const Logger = require('../utils/logger');

// Constants
const CONFIGURATION_FILE_NAME = 'config.js';
// Adjust path to look in root, not src
const CONFIGURATION_PATH = path.join(process.cwd(), CONFIGURATION_FILE_NAME); 

function loadConfiguration() {
    if (!fs.existsSync(CONFIGURATION_PATH)) {
        throw new Error(`Configuration file ${CONFIGURATION_FILE_NAME} not found at ${CONFIGURATION_PATH}. Please copy config.example.js.`);
    }

    // Force clear cache for reload capabilities
    try {
        delete require.cache[require.resolve(CONFIGURATION_PATH)];
    } catch (error) {
        Logger.debug('Config not in cache, skipping delete');
    }

    const configuration = require(CONFIGURATION_PATH);
    validateConfiguration(configuration);

    return {
        ...configuration,
        wssPort: process.env.WSS_PORT || configuration.wssPort || 2333,
    };
}

function validateConfiguration(configuration) {
    if (!configuration.bots || !Array.isArray(configuration.bots) || configuration.bots.length === 0) {
        throw new Error('No bots configured. Please add at least one bot to the "bots" array.');
    }

    configuration.bots.forEach((bot, index) => {
        if (!bot.token || bot.token.includes('YOUR_FIRST_BOT_TOKEN')) {
            throw new Error(`Bot at index ${index} has an invalid token.`);
        }
        if (!bot.characterName) {
            throw new Error(`Bot at index ${index} has no characterName configured.`);
        }
    });
}

module.exports = { loadConfiguration };
