/**
 * @fileoverview Server entry point for SillyTavern Telegram Connector.
 * Orchestrates configuration, services, and lifecycle management.
 * @module server
 */

const path = require('path');
const { spawn } = require('child_process');
const Logger = require('./utils/logger');
const { loadConfiguration, reloadConfiguration } = require('./config');
const { EVENTS, JOB_TYPES, COMMANDS } = require('./constants/system');
const QueueManager = require('./services/queueManager');
const WebSocketService = require('./services/webSocketService');
const TelegramService = require('./services/telegramService');

/**
 * @typedef {import('./types/index').ApplicationConfiguration} ApplicationConfiguration
 * @typedef {import('./types/index').QueueJob} QueueJob
 * @typedef {import('./types/index').ManagedBot} ManagedBot
 */

/** @type {ApplicationConfiguration|null} */
let configuration = null;

/**
 * Gets the message split character from configuration.
 * @returns {string} Split character or empty string.
 */
function getMessageSplitCharacter() {
    return configuration?.behavior?.messageSplitChar || '';
}

/**
 * Sanitizes bot message text using configured regex.
 * @param {string} text - Text to sanitize.
 * @returns {string} Sanitized text.
 */
function sanitizeBotMessage(text) {
    if (!configuration?.behavior?.botMessageFilterRegex) {
        return text;
    }

    try {
        const regex = new RegExp(configuration.behavior.botMessageFilterRegex, 'g');
        return text.replace(regex, '');
    } catch (error) {
        Logger.error('Invalid botMessageFilterRegex:', error.message);
        return text;
    }
}

/**
 * Processes a job through the queue system.
 * @param {QueueJob} job - The job to process.
 * @returns {Promise<void>}
 */
async function processJob(job) {
    const queueManager = QueueManager.getInstance();
    const webSocketService = WebSocketService.getInstance();
    const telegramService = TelegramService.getInstance();

    try {
        // Step 1: Switch character
        Logger.info(`Requesting character switch to "${job.targetCharacter}"`);
        webSocketService.sendToSillyTavern({
            type: EVENTS.EXECUTE_COMMAND,
            command: COMMANDS.SWITCH_CHARACTER,
            args: [job.targetCharacter],
            chatId: job.chatId,
            botId: job.managedBot.id,
            isQueuedSwitch: true,
        });

        await queueManager.waitForCharacterSwitch(30000);

        // Step 2: Switch model if configured
        if (job.managedBot.connectionProfile) {
            Logger.info(`Requesting model switch to "${job.managedBot.connectionProfile}"`);
            webSocketService.sendToSillyTavern({
                type: EVENTS.EXECUTE_COMMAND,
                command: COMMANDS.SWITCH_MODEL,
                args: [job.managedBot.connectionProfile],
                chatId: job.chatId,
                botId: job.managedBot.id,
                isQueuedSwitch: true,
            });

            await queueManager.waitForCharacterSwitch(15000);
        }

        // Step 3: Process the request
        if (job.type === JOB_TYPES.MESSAGE) {
            await sendUserMessage(job, telegramService, webSocketService);
        } else if (job.type === JOB_TYPES.COMMAND) {
            await executeCommand(job, webSocketService);
        }
    } catch (error) {
        throw error;
    }
}

/**
 * Sends user message to SillyTavern.
 * @param {QueueJob} job - The job.
 * @param {TelegramService} telegramService - Telegram service.
 * @param {WebSocketService} webSocketService - WebSocket service.
 * @returns {Promise<void>}
 */
async function sendUserMessage(job, telegramService, webSocketService) {
    Logger.info(`Sending user message to SillyTavern for job ${job.id}`);

    job.managedBot.instance.sendChatAction(job.chatId, 'typing')
        .catch((error) => Logger.error('Failed to send typing action:', error.message));

    const payloadMessages = [];
    const sourceMessages = job.messages || [{ text: job.text, files: job.files }];

    for (const message of sourceMessages) {
        let fileAttachments;

        if (message.files && message.files.length > 0) {
            Logger.info(`Downloading ${message.files.length} file(s) from Telegram...`);
            fileAttachments = [];

            for (const file of message.files) {
                const downloaded = await telegramService.downloadFile(
                    job.managedBot.instance,
                    file.fileId,
                    file.fileName,
                    file.mimeType
                );

                if (downloaded) {
                    fileAttachments.push(downloaded);
                    Logger.info(`Successfully downloaded: ${file.fileName}`);
                } else {
                    Logger.error(`Failed to download: ${file.fileName}`);
                }
            }

            if (fileAttachments.length === 0) {
                fileAttachments = undefined;
            }
        }

        payloadMessages.push({
            text: message.text,
            files: fileAttachments,
        });
    }

    webSocketService.sendToSillyTavern({
        type: EVENTS.USER_MESSAGE,
        chatId: job.chatId,
        botId: job.managedBot.id,
        characterName: job.targetCharacter,
        messages: payloadMessages,
    });

    Logger.info(`Sent to SillyTavern: ${payloadMessages.length} messages`);
}

/**
 * Executes a command.
 * @param {QueueJob} job - The job.
 * @param {WebSocketService} webSocketService - WebSocket service.
 * @returns {Promise<void>}
 */
async function executeCommand(job, webSocketService) {
    Logger.info(`Executing command /${job.command} for job ${job.id}`);

    job.managedBot.instance.sendChatAction(job.chatId, 'typing')
        .catch((error) => Logger.error('Failed to send typing action:', error.message));

    const payload = {
        type: EVENTS.EXECUTE_COMMAND,
        command: job.command,
        args: job.arguments || [],
        chatId: job.chatId,
        botId: job.managedBot.id,
        characterName: job.targetCharacter,
    };

    // Include summarization config for summarize/set_summary commands
    if (job.command === COMMANDS.SUMMARIZE || job.command === COMMANDS.SET_SUMMARY) {
        Logger.info(`Summarization config check: has summarization=${!!configuration?.summarization}, has prompt=${!!configuration?.summarization?.prompt}`);
        if (configuration?.summarization?.prompt) {
            Logger.info(`Custom prompt length: ${configuration.summarization.prompt.length} chars`);
        }
        payload.summarizationConfig = {
            prompt: configuration?.summarization?.prompt || null,
            lorebookName: job.managedBot.lorebookName || null,
            lorebookEntry: job.managedBot.lorebookEntry || null,
        };
    }

    webSocketService.sendToSillyTavern(payload);
}

/**
 * Handles system commands.
 * @param {string} command - Command name.
 * @param {number} chatId - Chat ID.
 * @param {ManagedBot} managedBot - The bot.
 */
async function handleSystemCommand(command, chatId, managedBot) {
    switch (command) {
        case COMMANDS.RELOAD:
            await handleReload(chatId, managedBot);
            break;
        case COMMANDS.RESTART:
            await handleRestart(chatId, managedBot);
            break;
        case COMMANDS.EXIT:
            await handleExit();
            break;
    }
}

/**
 * Handles configuration reload.
 * @param {number} chatId - Chat ID.
 * @param {ManagedBot} managedBot - The bot.
 */
async function handleReload(chatId, managedBot) {
    Logger.info('Reloading server configuration...');

    try {
        const newConfiguration = reloadConfiguration();

        if (!newConfiguration) {
            await managedBot.instance.sendMessage(chatId, 'Configuration reload failed: Invalid configuration.');
            return;
        }

        Object.assign(configuration, newConfiguration);
        Logger.info('Configuration reloaded successfully');
        await managedBot.instance.sendMessage(chatId, 'Configuration reloaded successfully.');
    } catch (error) {
        Logger.error('Error reloading configuration:', error.message);
        await managedBot.instance.sendMessage(chatId, 'Error reloading configuration: ' + error.message);
    }
}

/**
 * Handles server restart.
 * @param {number} chatId - Chat ID.
 * @param {ManagedBot} managedBot - The bot.
 */
async function handleRestart(chatId, managedBot) {
    Logger.info('Restarting server...');

    await managedBot.instance.sendMessage(chatId, 'Restarting server...');

    const telegramService = TelegramService.getInstance();
    await telegramService.stopAll();

    const webSocketService = WebSocketService.getInstance();
    await webSocketService.close();

    Logger.info('Services stopped, spawning new process...');

    setTimeout(() => {
        const serverPath = path.join(__dirname, 'server.js');
        const cleanEnvironment = {
            PATH: process.env.PATH,
            NODE_PATH: process.env.NODE_PATH,
            TELEGRAM_CLEAR_UPDATES: '1',
            RESTART_NOTIFY_CHATID: chatId.toString(),
            RESTART_NOTIFY_BOT_TOKEN: managedBot.token,
        };
        const child = spawn(process.execPath, [serverPath], {
            detached: true,
            stdio: 'inherit',
            env: cleanEnvironment,
        });
        child.unref();
        process.exit(0);
    }, 1000);
}

/**
 * Handles graceful shutdown.
 */
async function handleExit() {
    Logger.info('Shutting down server...');

    const forceExitTimeout = setTimeout(() => {
        Logger.error('Exit timeout, forcing process exit');
        process.exit(1);
    }, 10000);

    const telegramService = TelegramService.getInstance();
    await telegramService.stopAll();

    const webSocketService = WebSocketService.getInstance();
    await webSocketService.close();

    clearTimeout(forceExitTimeout);
    Logger.info('Server shut down successfully');
    process.exit(0);
}

/**
 * Sends restart notification if applicable.
 */
async function sendRestartNotification() {
    if (!process.env.RESTART_NOTIFY_CHATID || !process.env.RESTART_NOTIFY_BOT_TOKEN) {
        return;
    }

    const chatId = parseInt(process.env.RESTART_NOTIFY_CHATID);
    const botToken = process.env.RESTART_NOTIFY_BOT_TOKEN;
    const botId = botToken.split(':')[0];

    const telegramService = TelegramService.getInstance();
    const managedBot = telegramService.getBot(botId);

    if (!isNaN(chatId) && managedBot) {
        setTimeout(() => {
            managedBot.instance.sendMessage(chatId, 'Server successfully restarted and ready.')
                .catch((error) => Logger.error('Failed to send restart notification:', error.message))
                .finally(() => {
                    delete process.env.RESTART_NOTIFY_CHATID;
                    delete process.env.RESTART_NOTIFY_BOT_TOKEN;
                });
        }, 2000);
    }
}

/**
 * Main entry point.
 * @returns {Promise<void>}
 */
async function main() {
    Logger.info('Starting SillyTavern Telegram Connector...');

    // Load configuration
    configuration = loadConfiguration();
    if (!configuration) {
        Logger.error('Failed to load configuration, exiting');
        process.exit(1);
    }

    // Initialize services
    const queueManager = QueueManager.getInstance();
    const webSocketService = WebSocketService.getInstance();
    const telegramService = TelegramService.getInstance();

    // Configure QueueManager
    queueManager.configure({
        debounceSeconds: configuration.behavior.debounceSeconds,
        jobProcessor: processJob,
        connectionChecker: () => webSocketService.isConnected(),
        disconnectNotifier: async (job, message) => {
            await telegramService.sendMessage(job.managedBot, job.chatId, message);
        },
        onJobReleased: (activeJob) => {
            if (activeJob) {
                webSocketService.clearChatAction(activeJob.job.managedBot.id, activeJob.job.chatId);
            }
        },
    });

    // Configure WebSocketService
    webSocketService.configure({
        botLookup: (botId) => telegramService.getBot(botId),
        telegramSender: async (managedBot, chatId, text) => {
            await telegramService.sendMessage(managedBot, chatId, text);
        },
        imageSender: async (managedBot, chatId, images) => {
            await telegramService.sendImages(managedBot, chatId, images);
        },
        messageSplitter: getMessageSplitCharacter,
        messageSanitizer: sanitizeBotMessage,
    });

    // Set up system command handler
    telegramService.onSystemCommand(handleSystemCommand);

    // Start WebSocket server
    await webSocketService.initialize(configuration.wssPort);

    // Initialize Telegram bots
    await telegramService.initialize(configuration);

    Logger.info('All bots initialized and ready');

    // Send restart notification
    await sendRestartNotification();

    // Signal handlers
    process.on('SIGINT', async () => {
        Logger.info('Received SIGINT, shutting down...');
        await handleExit();
    });

    process.on('SIGTERM', async () => {
        Logger.info('Received SIGTERM, shutting down...');
        await handleExit();
    });

    process.on('uncaughtException', (error) => {
        Logger.error('Uncaught exception:', error.message);
        Logger.error(error.stack);
    });

    process.on('unhandledRejection', (reason, promise) => {
        Logger.error('Unhandled rejection at:', promise, 'reason:', reason);
    });
}

// Start the server
main().catch((error) => {
    Logger.error('Failed to start server:', error.message);
    Logger.error(error.stack);
    process.exit(1);
});
