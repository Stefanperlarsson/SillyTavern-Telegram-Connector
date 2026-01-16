// server.js
// SillyTavern Telegram Bridge - Bot-per-Character Architecture
// This server manages multiple Telegram bots, each representing a dedicated SillyTavern character.
// All requests are serialized through a FIFO queue with mutex to prevent race conditions.

const TelegramBot = require('node-telegram-bot-api');
const WebSocket = require('ws');
const fs = require('fs');
const path = require('path');

// ============================================================================
// TYPE DEFINITIONS (JSDoc)
// ============================================================================

/**
 * @typedef {Object} BotConfig
 * @property {string} token - Telegram Bot API token
 * @property {string} characterName - Exact name of the SillyTavern character
 */

/**
 * @typedef {Object} ManagedBot
 * @property {string} id - Unique identifier (derived from token)
 * @property {TelegramBot} instance - The node-telegram-bot-api instance
 * @property {string} characterName - The character this bot represents
 * @property {string} token - The bot's token (for restart notifications)
 */

/**
 * @typedef {Object} QueueJob
 * @property {string} id - Unique job identifier
 * @property {ManagedBot} bot - The bot that received the message
 * @property {number} chatId - Telegram chat ID
 * @property {number} userId - Telegram user ID
 * @property {string} text - Message text
 * @property {string} targetCharacter - Character name to switch to
 * @property {'message' | 'command'} type - Job type
 * @property {string} [command] - Command name (if type is 'command')
 * @property {string[]} [args] - Command arguments (if type is 'command')
 * @property {number} timestamp - When the job was created
 */

/**
 * @typedef {Object} StreamSession
 * @property {Promise<number>} messagePromise - Promise resolving to the Telegram message ID
 * @property {string} lastText - Last streamed text content
 * @property {NodeJS.Timeout|null} timer - Throttle timer for edits
 * @property {boolean} isEditing - Whether an edit is currently in progress
 */

/**
 * @typedef {Object} ActiveJob
 * @property {QueueJob} job - The currently processing job
 * @property {boolean} characterSwitched - Whether the character switch is confirmed
 * @property {AbortController} [abortController] - For cancelling generation
 */

// ============================================================================
// LOGGING UTILITY
// ============================================================================

/**
 * Logs a message with timestamp prefix
 * @param {'log' | 'error' | 'warn'} level - Log level
 * @param {...any} args - Arguments to log
 */
function logWithTimestamp(level, ...args) {
    const now = new Date();
    const year = now.getFullYear();
    const month = String(now.getMonth() + 1).padStart(2, '0');
    const day = String(now.getDate()).padStart(2, '0');
    const hours = String(now.getHours()).padStart(2, '0');
    const minutes = String(now.getMinutes()).padStart(2, '0');
    const seconds = String(now.getSeconds()).padStart(2, '0');

    const timestamp = `${year}-${month}-${day} ${hours}:${minutes}:${seconds}`;
    const prefix = `[${timestamp}]`;

    switch (level) {
        case 'error':
            console.error(prefix, ...args);
            break;
        case 'warn':
            console.warn(prefix, ...args);
            break;
        default:
            console.log(prefix, ...args);
    }
}

// ============================================================================
// RESTART PROTECTION
// ============================================================================

const RESTART_PROTECTION_FILE = path.join(__dirname, '.restart_protection');
const MAX_RESTARTS = 3;
const RESTART_WINDOW_MS = 60000; // 1 minute

/**
 * Checks for restart loops and prevents resource exhaustion
 * Exits the process if too many restarts are detected within the time window
 */
function checkRestartProtection() {
    try {
        if (fs.existsSync(RESTART_PROTECTION_FILE)) {
            const data = JSON.parse(fs.readFileSync(RESTART_PROTECTION_FILE, 'utf8'));
            const now = Date.now();

            // Clean up expired restart records
            data.restarts = data.restarts.filter(time => now - time < RESTART_WINDOW_MS);
            data.restarts.push(now);

            if (data.restarts.length > MAX_RESTARTS) {
                logWithTimestamp('error', `Possible restart loop detected! Restarted ${data.restarts.length} times within ${RESTART_WINDOW_MS / 1000} seconds.`);
                logWithTimestamp('error', 'Server will exit to prevent resource exhaustion. Please manually check and fix the issue before restarting.');

                if (process.env.RESTART_NOTIFY_CHATID && process.env.RESTART_NOTIFY_BOT_TOKEN) {
                    const chatId = parseInt(process.env.RESTART_NOTIFY_CHATID);
                    if (!isNaN(chatId)) {
                        try {
                            const tempBot = new TelegramBot(process.env.RESTART_NOTIFY_BOT_TOKEN, { polling: false });
                            tempBot.sendMessage(chatId, 'Restart loop detected! Server has stopped to prevent resource exhaustion. Please check the issue manually.')
                                .finally(() => process.exit(1));
                        } catch (e) {
                            process.exit(1);
                        }
                        return;
                    }
                }
                process.exit(1);
            }

            fs.writeFileSync(RESTART_PROTECTION_FILE, JSON.stringify(data));
        } else {
            fs.writeFileSync(RESTART_PROTECTION_FILE, JSON.stringify({ restarts: [Date.now()] }));
        }
    } catch (error) {
        logWithTimestamp('error', 'Restart protection check failed:', error);
    }
}

checkRestartProtection();

// ============================================================================
// CONFIGURATION LOADING
// ============================================================================

const configPath = path.join(__dirname, './config.js');
if (!fs.existsSync(configPath)) {
    logWithTimestamp('error', 'Error: Configuration file config.js not found!');
    logWithTimestamp('error', 'Please copy config.example.js to config.js in the server directory and configure your bots');
    process.exit(1);
}

let config = require('./config');

/**
 * Validates the configuration file structure
 * @param {Object} cfg - Configuration object to validate
 * @returns {boolean} True if valid, exits process if invalid
 */
function validateConfig(cfg) {
    if (!cfg.bots || !Array.isArray(cfg.bots) || cfg.bots.length === 0) {
        logWithTimestamp('error', 'Error: No bots configured in config.js!');
        logWithTimestamp('error', 'Please add at least one bot configuration to the "bots" array.');
        return false;
    }

    for (let i = 0; i < cfg.bots.length; i++) {
        const bot = cfg.bots[i];
        if (!bot.token || bot.token === 'YOUR_FIRST_BOT_TOKEN_HERE' || bot.token === 'YOUR_SECOND_BOT_TOKEN_HERE') {
            logWithTimestamp('error', `Error: Bot ${i + 1} has an invalid token. Please set a valid Telegram Bot Token.`);
            return false;
        }
        if (!bot.characterName || bot.characterName === 'Character Name Here') {
            logWithTimestamp('error', `Error: Bot ${i + 1} has no characterName configured.`);
            return false;
        }
    }

    return true;
}

if (!validateConfig(config)) {
    process.exit(1);
}

const wssPort = config.wssPort || 2333;

// ============================================================================
// REQUEST QUEUE & MUTEX SYSTEM
// ============================================================================

/** @type {QueueJob[]} */
const requestQueue = [];

/** @type {ActiveJob|null} */
let activeJob = null;

/** @type {boolean} */
let isProcessing = false;

/**
 * Generates a unique job ID
 * @returns {string} Unique identifier
 */
function generateJobId() {
    return `job_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
}

/**
 * Adds a job to the queue and triggers processing
 * @param {QueueJob} job - The job to enqueue
 */
function enqueueJob(job) {
    job.id = generateJobId();
    job.timestamp = Date.now();
    requestQueue.push(job);
    logWithTimestamp('log', `Job ${job.id} enqueued for character "${job.targetCharacter}" (queue size: ${requestQueue.length})`);
    processQueue();
}

/**
 * Processes the next job in the queue if not already processing
 * Implements the mutex lock pattern
 */
async function processQueue() {
    // Mutex check - if already processing, exit
    if (isProcessing) {
        return;
    }

    // Check if there are jobs to process
    if (requestQueue.length === 0) {
        return;
    }

    // Check if SillyTavern is connected
    if (!sillyTavernClient || sillyTavernClient.readyState !== WebSocket.OPEN) {
        logWithTimestamp('warn', 'Cannot process queue: SillyTavern not connected');
        // Notify all queued users
        for (const job of requestQueue) {
            job.bot.instance.sendMessage(job.chatId, 'Sorry, I cannot connect to SillyTavern right now. Please ensure SillyTavern is open and the Telegram extension is enabled.')
                .catch(err => logWithTimestamp('error', 'Failed to send not-connected message:', err.message));
        }
        requestQueue.length = 0; // Clear queue
        return;
    }

    // Acquire lock
    isProcessing = true;

    // Dequeue the next job
    const job = requestQueue.shift();
    activeJob = {
        job: job,
        characterSwitched: false
    };

    logWithTimestamp('log', `Processing job ${job.id} for bot "${job.targetCharacter}"`);

    try {
        // Step 1: Switch character (and wait for confirmation)
        await switchCharacterAndWait(job);

        // Step 2: If character switch succeeded, process the actual request
        if (activeJob && activeJob.characterSwitched) {
            if (job.type === 'message') {
                await sendUserMessage(job);
            } else if (job.type === 'command') {
                await executeCommand(job);
            }
        }
    } catch (error) {
        logWithTimestamp('error', `Error processing job ${job.id}:`, error);
        job.bot.instance.sendMessage(job.chatId, `An error occurred: ${error.message}`)
            .catch(err => logWithTimestamp('error', 'Failed to send error message:', err.message));
        releaseJob();
    }
}

/**
 * Sends the switchchar command and waits for confirmation from the extension
 * @param {QueueJob} job - The current job
 * @returns {Promise<void>}
 */
function switchCharacterAndWait(job) {
    return new Promise((resolve, reject) => {
        const timeout = setTimeout(() => {
            reject(new Error('Character switch timed out after 30 seconds'));
        }, 30000);

        // Store the resolve/reject handlers on the active job for the WebSocket handler to use
        activeJob.switchResolve = () => {
            clearTimeout(timeout);
            activeJob.characterSwitched = true;
            resolve();
        };
        activeJob.switchReject = (error) => {
            clearTimeout(timeout);
            reject(error);
        };

        // Send switch character command to SillyTavern
        logWithTimestamp('log', `Requesting character switch to "${job.targetCharacter}"`);
        sillyTavernClient.send(JSON.stringify({
            type: 'execute_command',
            command: 'switchchar',
            args: [job.targetCharacter],
            chatId: job.chatId,
            botId: job.bot.id,
            isQueuedSwitch: true // Flag to indicate this is part of queue processing
        }));
    });
}

/**
 * Sends the user message to SillyTavern for generation
 * @param {QueueJob} job - The current job
 */
async function sendUserMessage(job) {
    logWithTimestamp('log', `Sending user message to SillyTavern for job ${job.id}`);

    // Send typing indicator
    job.bot.instance.sendChatAction(job.chatId, 'typing')
        .catch(err => logWithTimestamp('error', 'Failed to send typing action:', err.message));

    // Send the message to SillyTavern
    sillyTavernClient.send(JSON.stringify({
        type: 'user_message',
        chatId: job.chatId,
        text: job.text,
        botId: job.bot.id,
        characterName: job.targetCharacter
    }));
}

/**
 * Executes a command for the current job
 * @param {QueueJob} job - The current job
 */
async function executeCommand(job) {
    logWithTimestamp('log', `Executing command /${job.command} for job ${job.id}`);

    // Send typing indicator
    job.bot.instance.sendChatAction(job.chatId, 'typing')
        .catch(err => logWithTimestamp('error', 'Failed to send typing action:', err.message));

    // Send the command to SillyTavern
    sillyTavernClient.send(JSON.stringify({
        type: 'execute_command',
        command: job.command,
        args: job.args || [],
        chatId: job.chatId,
        botId: job.bot.id,
        characterName: job.targetCharacter
    }));
}

/**
 * Releases the current job and processes the next one in queue
 * Called when a job completes (success or failure)
 */
function releaseJob() {
    if (activeJob) {
        logWithTimestamp('log', `Releasing job ${activeJob.job.id}`);
    }
    activeJob = null;
    isProcessing = false;

    // Process next job in queue
    setImmediate(processQueue);
}

/**
 * Handles disconnection mid-generation by notifying the user and releasing the lock
 */
function handleDisconnectDuringProcessing() {
    if (activeJob) {
        const job = activeJob.job;
        job.bot.instance.sendMessage(job.chatId, 'Connection to SillyTavern was lost during processing. Please try again.')
            .catch(err => logWithTimestamp('error', 'Failed to send disconnect message:', err.message));

        // Reject any pending switch
        if (activeJob.switchReject) {
            activeJob.switchReject(new Error('SillyTavern disconnected'));
        }
    }

    // Clear all pending jobs
    for (const job of requestQueue) {
        job.bot.instance.sendMessage(job.chatId, 'Connection to SillyTavern was lost. Please try again later.')
            .catch(err => logWithTimestamp('error', 'Failed to send queue-clear message:', err.message));
    }
    requestQueue.length = 0;

    // Release lock
    activeJob = null;
    isProcessing = false;
}

// ============================================================================
// BOT MANAGER
// ============================================================================

/** @type {Map<string, ManagedBot>} */
const managedBots = new Map();

/**
 * Derives a unique bot ID from the token
 * @param {string} token - Bot token
 * @returns {string} Bot ID
 */
function getBotIdFromToken(token) {
    // Use the first part of the token (bot user ID) as identifier
    return token.split(':')[0];
}

/**
 * Initializes all bots from config
 * @returns {Promise<void>}
 */
async function initializeBots() {
    logWithTimestamp('log', `Initializing ${config.bots.length} bot(s)...`);

    for (const botConfig of config.bots) {
        const botId = getBotIdFromToken(botConfig.token);

        const bot = new TelegramBot(botConfig.token, { polling: false });

        /** @type {ManagedBot} */
        const managedBot = {
            id: botId,
            instance: bot,
            characterName: botConfig.characterName,
            token: botConfig.token
        };

        managedBots.set(botId, managedBot);

        // Set up message handler for this bot
        setupBotHandlers(managedBot);

        logWithTimestamp('log', `Bot "${botConfig.characterName}" (ID: ${botId}) initialized`);
    }

    // Clear pending messages and start polling for all bots
    await clearAndStartPollingAll();
}

/**
 * Clears pending messages and starts polling for all bots
 * @returns {Promise<void>}
 */
async function clearAndStartPollingAll() {
    const isRestart = process.env.TELEGRAM_CLEAR_UPDATES === '1';

    for (const [botId, managedBot] of managedBots) {
        try {
            logWithTimestamp('log', `Clearing message queue for bot "${managedBot.characterName}"...`);

            if (isRestart) {
                let updates;
                let lastUpdateId = 0;

                do {
                    updates = await managedBot.instance.getUpdates({
                        offset: lastUpdateId,
                        limit: 100,
                        timeout: 0
                    });

                    if (updates && updates.length > 0) {
                        lastUpdateId = updates[updates.length - 1].update_id + 1;
                    }
                } while (updates && updates.length > 0);
            } else {
                const updates = await managedBot.instance.getUpdates({ limit: 100, timeout: 0 });
                if (updates && updates.length > 0) {
                    const lastUpdateId = updates[updates.length - 1].update_id;
                    await managedBot.instance.getUpdates({ offset: lastUpdateId + 1, limit: 1, timeout: 0 });
                    logWithTimestamp('log', `Cleared ${updates.length} pending messages for bot "${managedBot.characterName}"`);
                }
            }

            // Start polling
            managedBot.instance.startPolling({ restart: true, clean: true });
            logWithTimestamp('log', `Bot "${managedBot.characterName}" polling started`);

        } catch (error) {
            logWithTimestamp('error', `Error starting bot "${managedBot.characterName}":`, error);
            managedBot.instance.startPolling({ restart: true, clean: true });
        }
    }

    if (isRestart) {
        delete process.env.TELEGRAM_CLEAR_UPDATES;
    }
}

/**
 * Sets up message and command handlers for a bot
 * @param {ManagedBot} managedBot - The managed bot instance
 */
function setupBotHandlers(managedBot) {
    managedBot.instance.on('message', (msg) => {
        const chatId = msg.chat.id;
        const text = msg.text;
        const userId = msg.from.id;
        const username = msg.from.username || 'N/A';

        // Check whitelist
        if (config.allowedUserIds && config.allowedUserIds.length > 0) {
            if (!config.allowedUserIds.includes(userId)) {
                logWithTimestamp('log', `Rejected access from non-whitelisted user (Bot: ${managedBot.characterName}):\n  - User ID: ${userId}\n  - Username: @${username}`);
                managedBot.instance.sendMessage(chatId, 'Sorry, you are not authorized to use this bot.')
                    .catch(err => logWithTimestamp('error', 'Failed to send rejection message:', err.message));
                return;
            }
        }

        if (!text) return;

        // Handle commands
        if (text.startsWith('/')) {
            handleBotCommand(managedBot, msg);
            return;
        }

        // Handle regular messages - enqueue for processing
        /** @type {QueueJob} */
        const job = {
            id: '', // Will be set by enqueueJob
            bot: managedBot,
            chatId: chatId,
            userId: userId,
            text: text,
            targetCharacter: managedBot.characterName,
            type: 'message',
            timestamp: 0 // Will be set by enqueueJob
        };

        logWithTimestamp('log', `Received message for "${managedBot.characterName}" from user ${userId}: "${text.substring(0, 50)}${text.length > 50 ? '...' : ''}"`);
        enqueueJob(job);
    });
}

/**
 * Handles bot commands (both system and character-specific)
 * @param {ManagedBot} managedBot - The bot that received the command
 * @param {Object} msg - Telegram message object
 */
function handleBotCommand(managedBot, msg) {
    const chatId = msg.chat.id;
    const text = msg.text;

    const parts = text.slice(1).trim().split(/\s+/);
    const command = parts[0].toLowerCase();
    const args = parts.slice(1);

    logWithTimestamp('log', `Command received on bot "${managedBot.characterName}": /${command}`);

    // System commands handled directly
    if (['reload', 'restart', 'exit', 'ping'].includes(command)) {
        handleSystemCommand(command, chatId, managedBot);
        return;
    }

    // Help command
    if (command === 'help') {
        const helpText = `${managedBot.characterName} - Telegram Bridge Commands:

Chat Management
/new - Start a new chat with ${managedBot.characterName}
/listchats - List all saved chat logs for ${managedBot.characterName}
/switchchat <name> - Load a specific chat log
/switchchat_<N> - Load chat log by number

System Management
/reload - Reload server configuration
/restart - Restart server
/exit - Shutdown server
/ping - Check connection status

Help
/help - Show this help message

Note: This bot is dedicated to ${managedBot.characterName}. Messages you send will be processed as conversations with this character.`;

        managedBot.instance.sendMessage(chatId, helpText)
            .catch(err => logWithTimestamp('error', 'Failed to send help message:', err.message));
        return;
    }

    // Commands that need queueing (they interact with SillyTavern)
    if (['new', 'listchats'].includes(command) || command.match(/^switchchat_?\d*$/)) {
        /** @type {QueueJob} */
        const job = {
            id: '',
            bot: managedBot,
            chatId: chatId,
            userId: msg.from.id,
            text: '',
            targetCharacter: managedBot.characterName,
            type: 'command',
            command: command,
            args: args,
            timestamp: 0
        };

        enqueueJob(job);
        return;
    }

    // Unknown command
    managedBot.instance.sendMessage(chatId, `Unknown command: /${command}. Use /help to see available commands.`)
        .catch(err => logWithTimestamp('error', 'Failed to send unknown command message:', err.message));
}

/**
 * Handles system commands that don't need queueing
 * @param {string} command - The command name
 * @param {number} chatId - Telegram chat ID
 * @param {ManagedBot} managedBot - The bot that received the command
 */
function handleSystemCommand(command, chatId, managedBot) {
    logWithTimestamp('log', `Executing system command: ${command}`);

    if (command === 'ping') {
        const bridgeStatus = 'Bridge status: Connected';
        const stStatus = sillyTavernClient && sillyTavernClient.readyState === WebSocket.OPEN ?
            'SillyTavern status: Connected' :
            'SillyTavern status: Not connected';
        const queueStatus = `Queue: ${requestQueue.length} pending, ${isProcessing ? 'processing' : 'idle'}`;
        const botsStatus = `Active bots: ${managedBots.size}`;

        managedBot.instance.sendMessage(chatId, `${bridgeStatus}\n${stStatus}\n${queueStatus}\n${botsStatus}`)
            .catch(err => logWithTimestamp('error', 'Failed to send ping response:', err.message));
        return;
    }

    let responseMessage = '';
    switch (command) {
        case 'reload':
            responseMessage = 'Reloading server configuration...';
            managedBot.instance.sendMessage(chatId, responseMessage)
                .then(() => reloadServer(chatId, managedBot))
                .catch(err => logWithTimestamp('error', 'Failed to send reload message:', err.message));
            break;
        case 'restart':
            responseMessage = 'Restarting server...';
            managedBot.instance.sendMessage(chatId, responseMessage)
                .then(() => restartServer(chatId, managedBot))
                .catch(err => logWithTimestamp('error', 'Failed to send restart message:', err.message));
            break;
        case 'exit':
            responseMessage = 'Shutting down server...';
            managedBot.instance.sendMessage(chatId, responseMessage)
                .then(() => exitServer())
                .catch(err => logWithTimestamp('error', 'Failed to send exit message:', err.message));
            break;
    }
}

// ============================================================================
// STREAMING SESSION MANAGEMENT
// ============================================================================

/**
 * Map of ongoing streaming sessions
 * Key format: `${botId}_${chatId}` to ensure uniqueness across bots
 * @type {Map<string, StreamSession>}
 */
const ongoingStreams = new Map();

/**
 * Gets the stream key for a bot/chat combination
 * @param {string} botId - Bot identifier
 * @param {number} chatId - Telegram chat ID
 * @returns {string} Unique stream key
 */
function getStreamKey(botId, chatId) {
    return `${botId}_${chatId}`;
}

// ============================================================================
// WEBSOCKET SERVER
// ============================================================================

const wss = new WebSocket.Server({ port: wssPort });
logWithTimestamp('log', `WebSocket server listening on port ${wssPort}...`);

/** @type {WebSocket|null} */
let sillyTavernClient = null;

wss.on('connection', ws => {
    logWithTimestamp('log', 'SillyTavern extension connected!');
    sillyTavernClient = ws;

    ws.on('message', async (message) => {
        let data;
        try {
            data = JSON.parse(message);

            // --- Handle character switch confirmation ---
            // Check for isQueuedSwitch flag OR switchchar command when we have a pending switch
            const isPendingSwitch = activeJob && activeJob.switchResolve && !activeJob.characterSwitched;
            const isSwitchResponse = data.isQueuedSwitch || (isPendingSwitch && data.command === 'switchchar');
            
            if (data.type === 'command_executed' && isSwitchResponse) {
                if (activeJob && activeJob.switchResolve) {
                    if (data.success) {
                        logWithTimestamp('log', `Character switch to "${data.characterName || 'unknown'}" confirmed`);
                        activeJob.switchResolve();
                    } else {
                        logWithTimestamp('error', `Character switch failed: ${data.message}`);
                        // Notify user of failure
                        activeJob.job.bot.instance.sendMessage(activeJob.job.chatId, `Failed to switch character: ${data.message}`)
                            .catch(err => logWithTimestamp('error', 'Failed to send switch error:', err.message));
                        activeJob.switchReject(new Error(data.message || 'Character switch failed'));
                        releaseJob();
                    }
                }
                return;
            }

            // --- Handle command execution results (non-switch) ---
            if (data.type === 'command_executed' && !isSwitchResponse) {
                logWithTimestamp('log', `Command ${data.command} execution completed: ${data.success ? 'success' : 'failure'}`);

                // Find the bot to send the response
                if (activeJob && data.botId === activeJob.job.bot.id) {
                    if (data.message) {
                        activeJob.job.bot.instance.sendMessage(activeJob.job.chatId, data.message)
                            .catch(err => logWithTimestamp('error', 'Failed to send command result:', err.message));
                    }
                    releaseJob();
                }
                return;
            }

            // --- Handle streaming text chunks ---
            if (data.type === 'stream_chunk' && data.chatId && data.botId) {
                const streamKey = getStreamKey(data.botId, data.chatId);
                const bot = managedBots.get(data.botId);

                if (!bot) {
                    logWithTimestamp('error', `Received stream_chunk for unknown bot: ${data.botId}`);
                    return;
                }

                let session = ongoingStreams.get(streamKey);

                if (!session) {
                    let resolveMessagePromise;
                    const messagePromise = new Promise(resolve => {
                        resolveMessagePromise = resolve;
                    });

                    session = {
                        messagePromise: messagePromise,
                        lastText: data.text,
                        timer: null,
                        isEditing: false,
                    };
                    ongoingStreams.set(streamKey, session);

                    bot.instance.sendMessage(data.chatId, 'Thinking...')
                        .then(sentMessage => {
                            resolveMessagePromise(sentMessage.message_id);
                        }).catch(err => {
                            logWithTimestamp('error', 'Failed to send initial streaming message:', err);
                            ongoingStreams.delete(streamKey);
                        });
                } else {
                    session.lastText = data.text;
                }

                // Throttled edit
                const messageId = await session.messagePromise;

                if (messageId && !session.isEditing && !session.timer) {
                    session.timer = setTimeout(async () => {
                        const currentSession = ongoingStreams.get(streamKey);
                        if (currentSession) {
                            const currentMessageId = await currentSession.messagePromise;
                            if (currentMessageId) {
                                currentSession.isEditing = true;
                                bot.instance.editMessageText(currentSession.lastText + ' ...', {
                                    chat_id: data.chatId,
                                    message_id: currentMessageId,
                                }).catch(err => {
                                    if (!err.message.includes('message is not modified'))
                                        logWithTimestamp('error', 'Failed to edit streaming message:', err.message);
                                }).finally(() => {
                                    if (ongoingStreams.has(streamKey)) {
                                        ongoingStreams.get(streamKey).isEditing = false;
                                    }
                                });
                            }
                            currentSession.timer = null;
                        }
                    }, 2000);
                }
                return;
            }

            // --- Handle stream end signal ---
            if (data.type === 'stream_end' && data.chatId && data.botId) {
                const streamKey = getStreamKey(data.botId, data.chatId);
                const session = ongoingStreams.get(streamKey);

                if (session) {
                    if (session.timer) {
                        clearTimeout(session.timer);
                    }
                    logWithTimestamp('log', `Stream end signal received, waiting for final update...`);
                } else {
                    logWithTimestamp('warn', `Received stream_end but no session found for ${streamKey}`);
                }
                return;
            }

            // --- Handle final message update ---
            if (data.type === 'final_message_update' && data.chatId && data.botId) {
                const streamKey = getStreamKey(data.botId, data.chatId);
                const bot = managedBots.get(data.botId);
                const session = ongoingStreams.get(streamKey);

                if (!bot) {
                    logWithTimestamp('error', `Received final_message_update for unknown bot: ${data.botId}`);
                    return;
                }

                if (session) {
                    const messageId = await session.messagePromise;
                    if (messageId) {
                        logWithTimestamp('log', `Sending final streamed message update`);
                        await bot.instance.editMessageText(data.text, {
                            chat_id: data.chatId,
                            message_id: messageId,
                        }).catch(err => {
                            if (!err.message.includes('message is not modified'))
                                logWithTimestamp('error', 'Failed to edit final message:', err.message);
                        });
                    }
                    ongoingStreams.delete(streamKey);
                    logWithTimestamp('log', `Streaming session ${streamKey} completed`);
                } else {
                    // Non-streaming reply
                    logWithTimestamp('log', `Sending non-streaming reply`);
                    await bot.instance.sendMessage(data.chatId, data.text)
                        .catch(err => logWithTimestamp('error', 'Failed to send final message:', err.message));
                }

                // Release the job lock
                releaseJob();
                return;
            }

            // --- Handle AI reply (non-streaming) ---
            if (data.type === 'ai_reply' && data.chatId && data.botId) {
                const bot = managedBots.get(data.botId);
                if (!bot) {
                    logWithTimestamp('error', `Received ai_reply for unknown bot: ${data.botId}`);
                    return;
                }

                logWithTimestamp('log', `Sending non-streaming AI reply`);
                await bot.instance.sendMessage(data.chatId, data.text)
                    .catch(err => logWithTimestamp('error', 'Failed to send AI reply:', err.message));

                releaseJob();
                return;
            }

            // --- Handle error messages ---
            if (data.type === 'error_message' && data.chatId && data.botId) {
                const bot = managedBots.get(data.botId);
                if (!bot) {
                    logWithTimestamp('error', `Received error_message for unknown bot: ${data.botId}`);
                    return;
                }

                logWithTimestamp('error', `Error from SillyTavern: ${data.text}`);
                await bot.instance.sendMessage(data.chatId, data.text)
                    .catch(err => logWithTimestamp('error', 'Failed to send error message:', err.message));

                releaseJob();
                return;
            }

            // --- Handle typing action ---
            if (data.type === 'typing_action' && data.chatId && data.botId) {
                const bot = managedBots.get(data.botId);
                if (bot) {
                    bot.instance.sendChatAction(data.chatId, 'typing')
                        .catch(err => logWithTimestamp('error', 'Failed to send typing action:', err.message));
                }
                return;
            }

        } catch (error) {
            logWithTimestamp('error', 'Error processing SillyTavern message:', error);
            if (data && data.chatId && data.botId) {
                const streamKey = getStreamKey(data.botId, data.chatId);
                ongoingStreams.delete(streamKey);
            }
            releaseJob();
        }
    });

    ws.on('close', () => {
        logWithTimestamp('log', 'SillyTavern extension disconnected.');
        sillyTavernClient = null;
        ongoingStreams.clear();
        handleDisconnectDuringProcessing();
    });

    ws.on('error', (error) => {
        logWithTimestamp('error', 'WebSocket error occurred:', error);
        sillyTavernClient = null;
        ongoingStreams.clear();
        handleDisconnectDuringProcessing();
    });
});

// ============================================================================
// SERVER LIFECYCLE MANAGEMENT
// ============================================================================

/**
 * Reloads server configuration
 * @param {number} chatId - Chat ID to notify
 * @param {ManagedBot} managedBot - Bot to send notification through
 */
function reloadServer(chatId, managedBot) {
    logWithTimestamp('log', 'Reloading server configuration...');

    try {
        delete require.cache[require.resolve('./config.js')];
        const newConfig = require('./config.js');

        if (!validateConfig(newConfig)) {
            managedBot.instance.sendMessage(chatId, 'Configuration reload failed: Invalid configuration.')
                .catch(err => logWithTimestamp('error', 'Failed to send error:', err.message));
            return;
        }

        Object.assign(config, newConfig);
        logWithTimestamp('log', 'Configuration reloaded successfully');
        managedBot.instance.sendMessage(chatId, 'Configuration reloaded successfully.')
            .catch(err => logWithTimestamp('error', 'Failed to send success:', err.message));
    } catch (error) {
        logWithTimestamp('error', 'Error reloading configuration:', error);
        managedBot.instance.sendMessage(chatId, 'Error reloading configuration: ' + error.message)
            .catch(err => logWithTimestamp('error', 'Failed to send error:', err.message));
    }
}

/**
 * Restarts the server process
 * @param {number} chatId - Chat ID to notify after restart
 * @param {ManagedBot} managedBot - Bot to send notification through
 */
async function restartServer(chatId, managedBot) {
    logWithTimestamp('log', 'Restarting server...');

    // Stop all bot polling
    const stopPromises = [];
    for (const [, bot] of managedBots) {
        stopPromises.push(bot.instance.stopPolling().catch(err => {
            logWithTimestamp('error', `Error stopping bot ${bot.characterName}:`, err);
        }));
    }
    await Promise.all(stopPromises);

    // Close WebSocket server
    if (wss) {
        wss.close(() => {
            logWithTimestamp('log', 'WebSocket server closed, restarting...');
            setTimeout(() => {
                const { spawn } = require('child_process');
                const serverPath = path.join(__dirname, 'server.js');
                const cleanEnv = {
                    PATH: process.env.PATH,
                    NODE_PATH: process.env.NODE_PATH,
                    TELEGRAM_CLEAR_UPDATES: '1',
                    RESTART_NOTIFY_CHATID: chatId.toString(),
                    RESTART_NOTIFY_BOT_TOKEN: managedBot.token
                };
                const child = spawn(process.execPath, [serverPath], { detached: true, stdio: 'inherit', env: cleanEnv });
                child.unref();
                process.exit(0);
            }, 1000);
        });
    }
}

/**
 * Gracefully shuts down the server
 */
async function exitServer() {
    logWithTimestamp('log', 'Shutting down server...');

    const forceExitTimeout = setTimeout(() => {
        logWithTimestamp('error', 'Exit timeout, forcing process exit');
        process.exit(1);
    }, 10000);

    try {
        if (fs.existsSync(RESTART_PROTECTION_FILE)) {
            fs.unlinkSync(RESTART_PROTECTION_FILE);
        }
    } catch (error) {
        logWithTimestamp('error', 'Failed to clean up restart protection file:', error);
    }

    // Stop all bot polling
    const stopPromises = [];
    for (const [, bot] of managedBots) {
        stopPromises.push(bot.instance.stopPolling().catch(err => {
            logWithTimestamp('error', `Error stopping bot ${bot.characterName}:`, err);
        }));
    }
    await Promise.all(stopPromises);

    if (wss) {
        wss.close(() => {
            logWithTimestamp('log', 'WebSocket server closed');
            clearTimeout(forceExitTimeout);
            logWithTimestamp('log', 'Server shut down successfully');
            process.exit(0);
        });
    } else {
        clearTimeout(forceExitTimeout);
        process.exit(0);
    }
}

// ============================================================================
// STARTUP
// ============================================================================

// Initialize all bots
initializeBots().then(() => {
    logWithTimestamp('log', 'All bots initialized and ready');

    // Send restart notification if applicable
    if (process.env.RESTART_NOTIFY_CHATID && process.env.RESTART_NOTIFY_BOT_TOKEN) {
        const chatId = parseInt(process.env.RESTART_NOTIFY_CHATID);
        const botToken = process.env.RESTART_NOTIFY_BOT_TOKEN;
        const botId = getBotIdFromToken(botToken);
        const bot = managedBots.get(botId);

        if (!isNaN(chatId) && bot) {
            setTimeout(() => {
                bot.instance.sendMessage(chatId, 'Server successfully restarted and ready.')
                    .catch(err => logWithTimestamp('error', 'Failed to send restart notification:', err.message))
                    .finally(() => {
                        delete process.env.RESTART_NOTIFY_CHATID;
                        delete process.env.RESTART_NOTIFY_BOT_TOKEN;
                    });
            }, 2000);
        }
    }
}).catch(error => {
    logWithTimestamp('error', 'Failed to initialize bots:', error);
    process.exit(1);
});
