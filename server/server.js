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
 * @property {string} [connectionProfile] - Optional connection profile name
 */

/**
 * @typedef {Object} ManagedBot
 * @property {string} id - Unique identifier (derived from token)
 * @property {TelegramBot} instance - The node-telegram-bot-api instance
 * @property {string} characterName - The character this bot represents
 * @property {string} token - The bot's token (for restart notifications)
 * @property {string} [connectionProfile] - The connection profile to use
 */

/**
 * @typedef {Object} FileAttachment
 * @property {string} fileId - Telegram file ID
 * @property {string} fileName - Original file name
 * @property {string} mimeType - MIME type of the file
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
 * @property {FileAttachment[]} [files] - File attachments from Telegram
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

/**
 * Formats a Unix timestamp to YYYY-MM-DD HH:mm:ss
 * @param {number} unixTimestamp - Unix timestamp in seconds
 * @returns {string} Formatted date string
 */
function formatTimestamp(unixTimestamp) {
    const date = new Date(unixTimestamp * 1000);
    const year = date.getFullYear();
    const month = String(date.getMonth() + 1).padStart(2, '0');
    const day = String(date.getDate()).padStart(2, '0');
    const hours = String(date.getHours()).padStart(2, '0');
    const minutes = String(date.getMinutes()).padStart(2, '0');
    const seconds = String(date.getSeconds()).padStart(2, '0');
    return `${year}-${month}-${day} ${hours}:${minutes}:${seconds}`;
}

/**
 * Strips the timestamp from the bot's response using the configured regex
 * @param {string} text - The text to sanitize
 * @returns {string} Sanitized text
 */
function sanitizeBotMessage(text) {
    if (!config.behavior || !config.behavior.botMessageFilterRegex) return text;
    try {
        const regex = new RegExp(config.behavior.botMessageFilterRegex);
        return text.replace(regex, '');
    } catch (e) {
        logWithTimestamp('error', 'Invalid botMessageFilterRegex:', e.message);
        return text;
    }
}

/**
 * Gets the message split character from config
 * @returns {string|null} The split character or null if disabled
 */
function getMessageSplitChar() {
    if (!config.behavior || !config.behavior.messageSplitChar) return null;
    return config.behavior.messageSplitChar;
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

// ============================================================================
// MESSAGE BATCHING & DEBOUNCE
// ============================================================================

const DEBOUNCE_MS = (config.behavior && config.behavior.debounceSeconds ? config.behavior.debounceSeconds : 10) * 1000;

/** 
 * Buffers for user messages
 * Key: chatId (number)
 * Value: { timer: NodeJS.Timeout, messages: Array<{text, files}>, bot: ManagedBot, userId: number, targetCharacter: string }
 * @type {Map<number, Object>} 
 */
const userMessageBuffers = new Map();

/**
 * Adds a user message to the buffer and resets the debounce timer
 * @param {ManagedBot} bot - The bot receiving the message
 * @param {number} chatId - Telegram chat ID
 * @param {number} userId - Telegram user ID
 * @param {string} text - Message text
 * @param {FileAttachment[]} [files] - File attachments
 */
function debounceUserMessage(bot, chatId, userId, text, files) {
    let buffer = userMessageBuffers.get(chatId);

    if (buffer) {
        clearTimeout(buffer.timer);
    } else {
        buffer = {
            messages: [],
            bot: bot,
            userId: userId,
            targetCharacter: bot.characterName
        };
        userMessageBuffers.set(chatId, buffer);
    }

    if (text || (files && files.length > 0)) {
        buffer.messages.push({
            text: text,
            files: files
        });
        logWithTimestamp('log', `Buffered message for chat ${chatId} (buffer size: ${buffer.messages.length})`);
    }

    buffer.timer = setTimeout(() => {
        flushUserMessageBuffer(chatId);
    }, DEBOUNCE_MS);
}

/**
 * Flushes the message buffer for a chat, creating a single batch job
 * @param {number} chatId - The chat ID to flush
 */
function flushUserMessageBuffer(chatId) {
    const buffer = userMessageBuffers.get(chatId);
    if (!buffer) return;

    userMessageBuffers.delete(chatId);

    if (buffer.messages.length === 0) return;

    logWithTimestamp('log', `Flushing buffer for chat ${chatId} with ${buffer.messages.length} messages`);

    const lastMsg = buffer.messages[buffer.messages.length - 1];
    
    const job = {
        id: '', 
        bot: buffer.bot,
        chatId: chatId,
        userId: buffer.userId,
        text: lastMsg.text || '(Batch Request)',
        targetCharacter: buffer.targetCharacter,
        type: 'message',
        messages: buffer.messages,
        files: undefined,
        timestamp: 0
    };

    enqueueJob(job);
}

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

        // Step 2: Switch model/connection profile if configured
        if (activeJob && activeJob.characterSwitched) {
            await switchModelAndWait(job);
        }

        // Step 3: If switches succeeded, process the actual request
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
 * Sends the switchmodel command and waits for confirmation from the extension
 * @param {QueueJob} job - The current job
 * @returns {Promise<void>}
 */
function switchModelAndWait(job) {
    // If no model configured, resolve immediately
    if (!job.bot.connectionProfile) {
        return Promise.resolve();
    }

    return new Promise((resolve, reject) => {
        const timeout = setTimeout(() => {
            reject(new Error(`Model switch to "${job.bot.connectionProfile}" timed out`));
        }, 15000); // 15 seconds timeout for model switch

        // Re-use activeJob.switchResolve/Reject but for model
        // We know character switch is done, so we can overwrite these handlers
        activeJob.switchResolve = () => {
            clearTimeout(timeout);
            resolve();
        };
        activeJob.switchReject = (error) => {
            clearTimeout(timeout);
            reject(error);
        };

        logWithTimestamp('log', `Requesting model switch to "${job.bot.connectionProfile}"`);
        sillyTavernClient.send(JSON.stringify({
            type: 'execute_command',
            command: 'switchmodel',
            args: [job.bot.connectionProfile],
            chatId: job.chatId,
            botId: job.bot.id,
            isQueuedSwitch: true // Use same flag to indicate it's a blocking background op
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

    // Prepare messages array for payload
    const payloadMessages = [];
    
    // Check if it's a batch job or legacy single job
    const sourceMessages = job.messages || [{ text: job.text, files: job.files }];

    for (const msg of sourceMessages) {
        let fileAttachments = undefined;
        
        if (msg.files && msg.files.length > 0) {
            logWithTimestamp('log', `Downloading ${msg.files.length} file(s) from Telegram...`);
            fileAttachments = [];
            
            for (const file of msg.files) {
                const downloaded = await downloadTelegramFile(
                    job.bot.instance,
                    file.fileId,
                    file.fileName,
                    file.mimeType
                );
                
                if (downloaded) {
                    fileAttachments.push(downloaded);
                    logWithTimestamp('log', `Successfully downloaded: ${file.fileName}`);
                } else {
                    logWithTimestamp('error', `Failed to download: ${file.fileName}`);
                }
            }
            
            if (fileAttachments.length === 0) {
                fileAttachments = undefined;
            }
        }
        
        payloadMessages.push({
            text: msg.text,
            files: fileAttachments
        });
    }

    // Send the message to SillyTavern
    const payload = {
        type: 'user_message',
        chatId: job.chatId,
        botId: job.bot.id,
        characterName: job.targetCharacter,
        messages: payloadMessages
    };
    
    logWithTimestamp('log', `Sending to SillyTavern: ${payloadMessages.length} messages`);
    sillyTavernClient.send(JSON.stringify(payload));
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
            token: botConfig.token,
            connectionProfile: botConfig.connectionProfile
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

// ============================================================================
// MEDIA GROUP HANDLING
// ============================================================================

/**
 * Pending media groups waiting to be combined
 * Key: `${botId}_${chatId}_${mediaGroupId}`
 * @type {Map<string, {messages: Array, timer: NodeJS.Timeout, bot: ManagedBot, chatId: number, userId: number}>}
 */
const pendingMediaGroups = new Map();

/** Delay before processing a media group (ms) */
const MEDIA_GROUP_DELAY = 500;

/**
 * Gets a unique key for a media group
 * @param {string} botId - Bot identifier
 * @param {number} chatId - Chat ID
 * @param {string} mediaGroupId - Telegram media group ID
 * @returns {string}
 */
function getMediaGroupKey(botId, chatId, mediaGroupId) {
    return `${botId}_${chatId}_${mediaGroupId}`;
}

/**
 * Processes a completed media group into a single job
 * @param {string} groupKey - The media group key
 */
function processMediaGroup(groupKey) {
    const group = pendingMediaGroups.get(groupKey);
    if (!group) return;
    
    pendingMediaGroups.delete(groupKey);
    
    // Combine all files from all messages
    const allFiles = [];
    let caption = '';
    
    // Find the caption and apply timestamp if needed
    for (const msg of group.messages) {
        const files = extractFileAttachments(msg);
        allFiles.push(...files);
        
        // Use caption from first message that has one
        if (!caption && msg.caption) {
            caption = msg.caption;
            
            // Apply timestamp if configured
            if (config.behavior && config.behavior.userMessageFormat) {
                const dateStr = formatTimestamp(msg.date);
                const timestampPrefix = config.behavior.userMessageFormat.replace('{{date}}', dateStr);
                caption = timestampPrefix + caption;
            }
        }
    }
    
    // If no caption was found but we want timestamps, use the timestamp of the first message
    if (!caption && config.behavior && config.behavior.userMessageFormat && group.messages.length > 0) {
         const firstMsg = group.messages[0];
         const dateStr = formatTimestamp(firstMsg.date);
         caption = config.behavior.userMessageFormat.replace('{{date}}', dateStr);
    }
    
    logWithTimestamp('log', `Processing media group: ${group.messages.length} messages, ${allFiles.length} files, caption="${caption.substring(0, 30)}..."`);
    
    debounceUserMessage(
        group.bot, 
        group.chatId, 
        group.userId, 
        caption, 
        allFiles.length > 0 ? allFiles : undefined
    );
}

/**
 * Sets up message and command handlers for a bot
 * @param {ManagedBot} managedBot - The managed bot instance
 */
function setupBotHandlers(managedBot) {
    managedBot.instance.on('message', (msg) => {
        const chatId = msg.chat.id;
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

        // Handle media groups (albums) - buffer and combine
        if (msg.media_group_id) {
            const groupKey = getMediaGroupKey(managedBot.id, chatId, msg.media_group_id);
            
            let group = pendingMediaGroups.get(groupKey);
            if (!group) {
                // First message in this media group
                group = {
                    messages: [],
                    timer: null,
                    bot: managedBot,
                    chatId: chatId,
                    userId: userId,
                };
                pendingMediaGroups.set(groupKey, group);
                logWithTimestamp('log', `Started collecting media group: ${msg.media_group_id}`);
            }
            
            // Add this message to the group
            group.messages.push(msg);
            logWithTimestamp('log', `Added message to media group ${msg.media_group_id}, total: ${group.messages.length}`);
            
            // Reset/set the timer - process after MEDIA_GROUP_DELAY ms of no new messages
            if (group.timer) {
                clearTimeout(group.timer);
            }
            group.timer = setTimeout(() => {
                processMediaGroup(groupKey);
            }, MEDIA_GROUP_DELAY);
            
            return; // Don't process individually
        }

        // Extract text - use caption for media messages, otherwise use text
        let text = msg.text || msg.caption || '';

        // Extract file attachments
        const files = extractFileAttachments(msg);
        
        // Apply timestamp if configured
        if (config.behavior && config.behavior.userMessageFormat) {
            const dateStr = formatTimestamp(msg.date);
            const timestampPrefix = config.behavior.userMessageFormat.replace('{{date}}', dateStr);
            
            // If we have text, prepend. If we have only files but no text, add the timestamp as text.
            if (text || files.length > 0) {
                text = timestampPrefix + text;
            }
        }
        
        // Log what we received
        logWithTimestamp('log', `Received message for "${managedBot.characterName}" from user ${userId}: text="${text.substring(0, 50)}${text.length > 50 ? '...' : ''}", files=${files.length}`);

        // If no text and no files, ignore
        if (!text && files.length === 0) {
            logWithTimestamp('log', `Ignoring empty message (no text, no files)`);
            return;
        }

        // Handle commands (only if it's a text-only message starting with /)
        if (text.startsWith('/') && files.length === 0) {
            handleBotCommand(managedBot, msg);
            return;
        }

        // Handle regular messages - buffer for batching
        debounceUserMessage(managedBot, chatId, userId, text, files.length > 0 ? files : undefined);
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
/delete [n] - Delete the last n messages (default 1)
/trigger - Manually trigger a new AI response

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

    // Delete/Undo commands
    if (['delete'].includes(command)) {
        const count = args.length > 0 ? parseInt(args[0]) : 1;
        if (isNaN(count) || count < 1) {
            managedBot.instance.sendMessage(chatId, 'Invalid number of messages to delete.')
                .catch(err => logWithTimestamp('error', 'Failed to send error message:', err.message));
            return;
        }

        const job = {
            id: '',
            bot: managedBot,
            chatId: chatId,
            userId: msg.from.id,
            text: '',
            targetCharacter: managedBot.characterName,
            type: 'command',
            command: 'delete_messages',
            args: [count],
            timestamp: 0
        };
        enqueueJob(job);
        return;
    }

    // Trigger/Regenerate commands
    if (['trigger'].includes(command)) {
        const job = {
            id: '',
            bot: managedBot,
            chatId: chatId,
            userId: msg.from.id,
            text: '',
            targetCharacter: managedBot.characterName,
            type: 'command',
            command: 'trigger_generation',
            args: [],
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

// ============================================================================
// IMAGE HANDLING
// ============================================================================

/**
 * Sends images to a Telegram chat
 * @param {ManagedBot} bot - The bot to send through
 * @param {number} chatId - The chat ID to send to
 * @param {Array<{base64: string, mimeType: string, caption?: string}>} images - Images to send
 * @returns {Promise<void>}
 */
async function sendImagesToTelegram(bot, chatId, images) {
    for (const image of images) {
        try {
            // Convert base64 to Buffer
            const imageBuffer = Buffer.from(image.base64, 'base64');
            
            // Determine file extension from mime type
            const extMap = {
                'image/png': 'png',
                'image/jpeg': 'jpg',
                'image/jpg': 'jpg',
                'image/gif': 'gif',
                'image/webp': 'webp',
            };
            const ext = extMap[image.mimeType] || 'png';
            
            logWithTimestamp('log', `Sending image to Telegram: ${image.mimeType}, ${imageBuffer.length} bytes`);
            
            // Send the photo without caption (the prompt is not useful to show)
            // Use fileOptions to specify content type and avoid deprecation warning
            await bot.instance.sendPhoto(chatId, imageBuffer, {}, {
                filename: `image.${ext}`,
                contentType: image.mimeType,
            });
            
            logWithTimestamp('log', `Image sent successfully`);
        } catch (err) {
            logWithTimestamp('error', `Failed to send image: ${err.message}`);
        }
    }
}

/**
 * Downloads a file from Telegram and converts to base64
 * @param {TelegramBot} botInstance - Bot instance
 * @param {string} fileId - Telegram file ID
 * @param {string} fileName - Original file name
 * @param {string} mimeType - MIME type
 * @returns {Promise<{base64: string, mimeType: string, fileName: string}|null>}
 */
async function downloadTelegramFile(botInstance, fileId, fileName, mimeType) {
    try {
        logWithTimestamp('log', `Downloading file from Telegram: ${fileName} (${mimeType})`);
        
        // Get file link from Telegram
        const fileLink = await botInstance.getFileLink(fileId);
        logWithTimestamp('log', `Got file link: ${fileLink}`);
        
        // Fetch the file
        const response = await fetch(fileLink);
        if (!response.ok) {
            logWithTimestamp('error', `Failed to fetch file: ${response.status} ${response.statusText}`);
            return null;
        }
        
        // Get the buffer - need to handle both Node 18+ and older versions
        const arrayBuffer = await response.arrayBuffer();
        const buffer = Buffer.from(arrayBuffer);
        
        // Convert to base64
        const base64 = buffer.toString('base64');
        
        logWithTimestamp('log', `Downloaded file: ${fileName}, size: ${buffer.length} bytes, base64 length: ${base64.length}`);
        
        return { base64, mimeType, fileName };
    } catch (error) {
        logWithTimestamp('error', `Error downloading file from Telegram: ${error.message}`);
        return null;
    }
}

/**
 * Extracts file attachments from a Telegram message
 * @param {Object} msg - Telegram message object
 * @returns {FileAttachment[]} Array of file attachments
 */
function extractFileAttachments(msg) {
    const files = [];
    
    // Photos - array of sizes, pick largest (last)
    if (msg.photo && msg.photo.length > 0) {
        const photo = msg.photo[msg.photo.length - 1];
        files.push({
            fileId: photo.file_id,
            fileName: 'photo.jpg',
            mimeType: 'image/jpeg'
        });
        logWithTimestamp('log', `Found photo attachment: ${photo.file_id}`);
    }
    
    // Documents (generic files)
    if (msg.document) {
        files.push({
            fileId: msg.document.file_id,
            fileName: msg.document.file_name || 'document',
            mimeType: msg.document.mime_type || 'application/octet-stream'
        });
        logWithTimestamp('log', `Found document attachment: ${msg.document.file_name} (${msg.document.mime_type})`);
    }
    
    // Videos
    if (msg.video) {
        files.push({
            fileId: msg.video.file_id,
            fileName: msg.video.file_name || 'video.mp4',
            mimeType: msg.video.mime_type || 'video/mp4'
        });
        logWithTimestamp('log', `Found video attachment: ${msg.video.file_name || 'video.mp4'}`);
    }
    
    // Audio files
    if (msg.audio) {
        files.push({
            fileId: msg.audio.file_id,
            fileName: msg.audio.file_name || 'audio.mp3',
            mimeType: msg.audio.mime_type || 'audio/mpeg'
        });
        logWithTimestamp('log', `Found audio attachment: ${msg.audio.file_name || 'audio.mp3'}`);
    }
    
    // Voice messages
    if (msg.voice) {
        files.push({
            fileId: msg.voice.file_id,
            fileName: 'voice.ogg',
            mimeType: msg.voice.mime_type || 'audio/ogg'
        });
        logWithTimestamp('log', `Found voice message attachment`);
    }
    
    // Video notes (round video messages)
    if (msg.video_note) {
        files.push({
            fileId: msg.video_note.file_id,
            fileName: 'video_note.mp4',
            mimeType: 'video/mp4'
        });
        logWithTimestamp('log', `Found video note attachment`);
    }
    
    // Stickers
    if (msg.sticker) {
        const isAnimated = msg.sticker.is_animated;
        const isVideo = msg.sticker.is_video;
        files.push({
            fileId: msg.sticker.file_id,
            fileName: isVideo ? 'sticker.webm' : (isAnimated ? 'sticker.tgs' : 'sticker.webp'),
            mimeType: isVideo ? 'video/webm' : (isAnimated ? 'application/x-tgsticker' : 'image/webp')
        });
        logWithTimestamp('log', `Found sticker attachment`);
    }
    
    return files;
}

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
            
            // Sanitize bot output if it's a message from ST to Telegram
            if (data.text && (data.type === 'stream_chunk' || data.type === 'final_message_update' || data.type === 'ai_reply')) {
                data.text = sanitizeBotMessage(data.text);
            }

            // --- Handle character switch confirmation ---
            // Check for isQueuedSwitch flag OR switchchar/switchmodel command when we have a pending switch
            const isPendingSwitch = activeJob && activeJob.switchResolve;
            const isSwitchResponse = data.isQueuedSwitch || (isPendingSwitch && (data.command === 'switchchar' || data.command === 'switchmodel'));
            
            if (data.type === 'command_executed' && isSwitchResponse) {
                if (activeJob && activeJob.switchResolve) {
                    if (data.success) {
                        logWithTimestamp('log', `Command "${data.command}" successful`);
                        // Only set characterSwitched if it was indeed a character switch
                        if (data.command === 'switchchar') {
                            activeJob.characterSwitched = true;
                        }
                        activeJob.switchResolve();
                    } else {
                        logWithTimestamp('error', `Command "${data.command}" failed: ${data.message}`);
                        // Notify user of failure
                        activeJob.job.bot.instance.sendMessage(activeJob.job.chatId, `Failed to execute ${data.command}: ${data.message}`)
                            .catch(err => logWithTimestamp('error', 'Failed to send switch error:', err.message));
                        activeJob.switchReject(new Error(data.message || 'Switch failed'));
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

                // Throttled edit - only show the first part during streaming
                const messageId = await session.messagePromise;

                if (messageId && !session.isEditing && !session.timer) {
                    session.timer = setTimeout(async () => {
                        const currentSession = ongoingStreams.get(streamKey);
                        if (currentSession) {
                            const currentMessageId = await currentSession.messagePromise;
                            if (currentMessageId) {
                                currentSession.isEditing = true;
                                // Only display the first part during streaming to avoid showing full text
                                const splitChar = getMessageSplitChar();
                                const firstPart = splitChar 
                                    ? currentSession.lastText.split(splitChar)[0] 
                                    : currentSession.lastText;
                                bot.instance.editMessageText(firstPart + ' ...', {
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

                // Send any images first (before the text message)
                if (data.images && data.images.length > 0) {
                    logWithTimestamp('log', `Sending ${data.images.length} image(s) to Telegram`);
                    await sendImagesToTelegram(bot, data.chatId, data.images);
                }

                // Split by configured character to support multi-message responses
                const splitChar = getMessageSplitChar();
                const parts = splitChar ? data.text.split(splitChar) : [data.text];
                
                // Find the first non-empty part to use as the "anchor" (editing the existing streaming message)
                let anchorIndex = -1;
                for (let i = 0; i < parts.length; i++) {
                    if (parts[i].trim().length > 0) {
                        anchorIndex = i;
                        break;
                    }
                }

                if (session) {
                    const messageId = await session.messagePromise;
                    if (messageId) {
                        if (anchorIndex !== -1) {
                            logWithTimestamp('log', `Sending final streamed message update (Anchor: part ${anchorIndex})`);
                            await bot.instance.editMessageText(parts[anchorIndex], {
                                chat_id: data.chatId,
                                message_id: messageId,
                            }).catch(err => {
                                if (!err.message.includes('message is not modified'))
                                    logWithTimestamp('error', 'Failed to edit final message:', err.message);
                            });
                        } else {
                            // If response is completely empty/whitespace, log a warning
                            logWithTimestamp('warn', 'Final response text is empty or whitespace only.');
                        }
                    }
                    ongoingStreams.delete(streamKey);
                    logWithTimestamp('log', `Streaming session ${streamKey} completed`);
                } else {
                    // Non-streaming fallback - send anchor as new message
                    if (anchorIndex !== -1) {
                        logWithTimestamp('log', `Sending non-streaming reply (Anchor)`);
                        await bot.instance.sendMessage(data.chatId, parts[anchorIndex])
                            .catch(err => logWithTimestamp('error', 'Failed to send final message:', err.message));
                    }
                }

                // Send remaining parts as new messages
                if (anchorIndex !== -1) {
                    for (let i = anchorIndex + 1; i < parts.length; i++) {
                        if (parts[i].trim().length > 0) {
                            logWithTimestamp('log', `Sending split message part ${i}`);
                            await bot.instance.sendMessage(data.chatId, parts[i])
                                .catch(err => logWithTimestamp('error', 'Failed to send split message:', err.message));
                        }
                    }
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

                // Send any images first (before the text message)
                if (data.images && data.images.length > 0) {
                    logWithTimestamp('log', `Sending ${data.images.length} image(s) to Telegram`);
                    await sendImagesToTelegram(bot, data.chatId, data.images);
                }

                // Split by configured character to support multi-message responses
                const splitChar = getMessageSplitChar();
                const parts = splitChar ? data.text.split(splitChar) : [data.text];
                
                logWithTimestamp('log', `Sending non-streaming AI reply${splitChar ? ' (split by configured char)' : ''}`);
                
                for (const part of parts) {
                    if (part.trim().length > 0) {
                        await bot.instance.sendMessage(data.chatId, part)
                            .catch(err => logWithTimestamp('error', 'Failed to send AI reply part:', err.message));
                    }
                }

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
