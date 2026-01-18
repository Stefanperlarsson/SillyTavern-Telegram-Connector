const TelegramBot = require('node-telegram-bot-api');
const { loadConfiguration } = require('./config');
const Logger = require('./utils/logger');
const QueueManager = require('./services/queueManager');
const WebSocketService = require('./services/webSocketService');
const { EVENTS } = require('./constants/system');

// State
let configuration = null;
const managedBots = new Map();

/**
 * Main application entry point
 */
async function main() {
    try {
        Logger.info('Starting SillyTavern Telegram Connector...');
        
        // 1. Config
        configuration = loadConfiguration();
        
        // 2. Init Services
        WebSocketService.initialize(configuration.wssPort);
        
        // 3. Init Bots
        await initializeBots();

        // 4. Signals
        process.on('SIGINT', shutdown);
        process.on('SIGTERM', shutdown);

        Logger.info('System startup complete.');

    } catch (error) {
        Logger.error('Fatal startup error:', error);
        process.exit(1);
    }
}

async function initializeBots() {
    for (const botConfiguration of configuration.bots) {
        const botId = botConfiguration.token.split(':')[0];
        const botInstance = new TelegramBot(botConfiguration.token, { polling: false });

        const managedBot = {
            id: botId,
            instance: botInstance,
            characterName: botConfiguration.characterName,
            token: botConfiguration.token
        };

        managedBots.set(botId, managedBot);
        
        // Attach Message Handler
        botInstance.on('message', (message) => handleTelegramMessage(managedBot, message));
        
        // Start Polling
        botInstance.startPolling();
        Logger.info(`Bot "${botConfiguration.characterName}" started.`);
    }
}

function handleTelegramMessage(bot, message) {
    const text = message.text || '';
    const chatId = message.chat.id;
    const userId = message.from.id;

    Logger.info(`Received message from ${userId}: ${text}`);

    // Create Job
    const job = {
        bot: bot,
        chatId: chatId,
        userId: userId,
        text: text,
        targetCharacter: bot.characterName,
        type: 'message'
    };

    // Add to Queue
    const activeJob = QueueManager.enqueueJob(job);
    
    // If we picked up a job immediately, send to ST
    if (activeJob) {
        processJob(activeJob);
    }
}

function processJob(activeJob) {
    const job = activeJob.job;
    
    const payload = {
        type: EVENTS.USER_MESSAGE,
        chatId: job.chatId,
        botId: job.bot.id,
        characterName: job.targetCharacter,
        messages: [{ text: job.text }]
    };

    const sent = WebSocketService.sendToSillyTavern(payload);
    if (!sent) {
        job.bot.instance.sendMessage(job.chatId, 'SillyTavern not connected.');
        QueueManager.releaseJob();
    }
}

async function shutdown() {
    Logger.info('Shutting down...');
    for (const bot of managedBots.values()) {
        await bot.instance.stopPolling();
    }
    WebSocketService.close();
    process.exit(0);
}

main();
