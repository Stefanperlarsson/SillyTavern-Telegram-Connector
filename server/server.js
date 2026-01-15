// server.js
const TelegramBot = require('node-telegram-bot-api');
const WebSocket = require('ws');
const fs = require('fs');
const path = require('path');

// Add logging function with timestamp
function logWithTimestamp(level, ...args) {
    const now = new Date();

    // Format time using local timezone
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

// Restart protection - prevent restart loops
const RESTART_PROTECTION_FILE = path.join(__dirname, '.restart_protection');
const MAX_RESTARTS = 3;
const RESTART_WINDOW_MS = 60000; // 1 minute

// Check if possibly in a restart loop
function checkRestartProtection() {
    try {
        if (fs.existsSync(RESTART_PROTECTION_FILE)) {
            const data = JSON.parse(fs.readFileSync(RESTART_PROTECTION_FILE, 'utf8'));
            const now = Date.now();

            // Clean up expired restart records
            data.restarts = data.restarts.filter(time => now - time < RESTART_WINDOW_MS);

            // Add current restart time
            data.restarts.push(now);

            // If too many restarts within time window, exit
            if (data.restarts.length > MAX_RESTARTS) {
                logWithTimestamp('error', `Possible restart loop detected! Restarted ${data.restarts.length} times within ${RESTART_WINDOW_MS / 1000} seconds.`);
                logWithTimestamp('error', 'Server will exit to prevent resource exhaustion. Please manually check and fix the issue before restarting.');

                // If there's a notification chatId, try to send error message
                if (process.env.RESTART_NOTIFY_CHATID) {
                    const chatId = parseInt(process.env.RESTART_NOTIFY_CHATID);
                    if (!isNaN(chatId)) {
                        // Create temporary bot to send error message
                        try {
                            const tempBot = new TelegramBot(require('./config').telegramToken, { polling: false });
                            tempBot.sendMessage(chatId, 'Restart loop detected! Server has stopped to prevent resource exhaustion. Please check the issue manually.')
                                .finally(() => process.exit(1));
                        } catch (e) {
                            process.exit(1);
                        }
                        return; // Wait for message to send before exiting
                    }
                }

                process.exit(1);
            }

            // Save updated restart records
            fs.writeFileSync(RESTART_PROTECTION_FILE, JSON.stringify(data));
        } else {
            // Create new restart protection file
            fs.writeFileSync(RESTART_PROTECTION_FILE, JSON.stringify({ restarts: [Date.now()] }));
        }
    } catch (error) {
        logWithTimestamp('error', 'Restart protection check failed:', error);
        // Continue on error, don't prevent server startup
    }
}

// Check restart protection on startup
checkRestartProtection();

// Check if configuration file exists
const configPath = path.join(__dirname, './config.js');
if (!fs.existsSync(configPath)) {
    logWithTimestamp('error', 'Error: Configuration file config.js not found!');
    logWithTimestamp('error', 'Please copy config.example.js to config.js in the server directory and set your Telegram Bot Token');
    process.exit(1); // Terminate program
}

const config = require('./config');

// --- Configuration ---
// Get Telegram Bot Token and WebSocket port from configuration file
const token = config.telegramToken;
// WebSocket server port
const wssPort = config.wssPort;

// Check if default token was modified
if (token === 'TOKEN' || token === 'YOUR_TELEGRAM_BOT_TOKEN_HERE') {
    logWithTimestamp('error', 'Error: Please set your Telegram Bot Token in config.js first!');
    logWithTimestamp('error', 'Find the line telegramToken: \'YOUR_TELEGRAM_BOT_TOKEN_HERE\' and replace it with the token you got from BotFather');
    process.exit(1); // Terminate program
}

// Initialize Telegram Bot, but don't start polling immediately
const bot = new TelegramBot(token, { polling: false });
logWithTimestamp('log', 'Initializing Telegram Bot...');

// Manually clear all pending messages, then start polling
(async function clearAndStartPolling() {
    try {
        logWithTimestamp('log', 'Clearing Telegram message queue...');

        // Check if this is a restart, if so use more thorough clearing
        const isRestart = process.env.TELEGRAM_CLEAR_UPDATES === '1';
        if (isRestart) {
            logWithTimestamp('log', 'Restart marker detected, performing thorough message queue cleanup...');
            // Get updates and discard all messages
            let updates;
            let lastUpdateId = 0;

            // Loop to get all updates until no more updates
            do {
                updates = await bot.getUpdates({
                    offset: lastUpdateId,
                    limit: 100,
                    timeout: 0
                });

                if (updates && updates.length > 0) {
                    lastUpdateId = updates[updates.length - 1].update_id + 1;
                    logWithTimestamp('log', `Cleared ${updates.length} messages, current offset: ${lastUpdateId}`);
                }
            } while (updates && updates.length > 0);

            // Clear environment variable
            delete process.env.TELEGRAM_CLEAR_UPDATES;
            logWithTimestamp('log', 'Message queue cleanup complete');
        } else {
            // Normal startup cleanup
            const updates = await bot.getUpdates({ limit: 100, timeout: 0 });
            if (updates && updates.length > 0) {
                // If there are updates, get the last update ID and set offset to it+1
                const lastUpdateId = updates[updates.length - 1].update_id;
                await bot.getUpdates({ offset: lastUpdateId + 1, limit: 1, timeout: 0 });
                logWithTimestamp('log', `Cleared ${updates.length} pending messages`);
            } else {
                logWithTimestamp('log', 'No pending messages to clear');
            }
        }

        // Start polling
        bot.startPolling({
            restart: true,
            clean: true
        });
        logWithTimestamp('log', 'Telegram Bot polling started');
    } catch (error) {
        logWithTimestamp('error', 'Error clearing message queue or starting polling:', error);
        // If clearing fails, still try to start polling
        bot.startPolling({ restart: true, clean: true });
        logWithTimestamp('log', 'Telegram Bot polling started (after queue clearing failure)');
    }
})();

// Initialize WebSocket server
const wss = new WebSocket.Server({ port: wssPort });
logWithTimestamp('log', `WebSocket server listening on port ${wssPort}...`);

let sillyTavernClient = null; // Store connected SillyTavern extension client

// Store ongoing streaming sessions, adjust session structure to use Promise for messageId
// Structure: { messagePromise: Promise<number> | null, lastText: String, timer: NodeJS.Timeout | null, isEditing: boolean }
const ongoingStreams = new Map();

// Reload server function
function reloadServer(chatId) {
    logWithTimestamp('log', 'Reloading server-side component...');
    Object.keys(require.cache).forEach(function (key) {
        if (key.indexOf('node_modules') === -1) {
            delete require.cache[key];
        }
    });
    try {
        delete require.cache[require.resolve('./config.js')];
        const newConfig = require('./config.js');
        Object.assign(config, newConfig);
        logWithTimestamp('log', 'Configuration file reloaded');
    } catch (error) {
        logWithTimestamp('error', 'Error reloading configuration file:', error);
        if (chatId) bot.sendMessage(chatId, 'Error reloading configuration file: ' + error.message);
        return;
    }
    logWithTimestamp('log', 'Server-side component reloaded');
    if (chatId) bot.sendMessage(chatId, 'Server-side component successfully reloaded.');
}

// Restart server function
function restartServer(chatId) {
    logWithTimestamp('log', 'Restarting server-side component...');

    // First stop Telegram Bot polling
    bot.stopPolling().then(() => {
        logWithTimestamp('log', 'Telegram Bot polling stopped');

        // Then close WebSocket server
        if (wss) {
            wss.close(() => {
                logWithTimestamp('log', 'WebSocket server closed, preparing to restart...');
                setTimeout(() => {
                    const { spawn } = require('child_process');
                    const serverPath = path.join(__dirname, 'server.js');
                    logWithTimestamp('log', `Restarting server: ${serverPath}`);
                    const cleanEnv = {
                        PATH: process.env.PATH,
                        NODE_PATH: process.env.NODE_PATH,
                        TELEGRAM_CLEAR_UPDATES: '1' // Add marker to indicate this is a restart
                    };
                    if (chatId) cleanEnv.RESTART_NOTIFY_CHATID = chatId.toString();
                    const child = spawn(process.execPath, [serverPath], { detached: true, stdio: 'inherit', env: cleanEnv });
                    child.unref();
                    process.exit(0);
                }, 1000);
            });
        } else {
            // If no WebSocket server, restart directly
            setTimeout(() => {
                const { spawn } = require('child_process');
                const serverPath = path.join(__dirname, 'server.js');
                logWithTimestamp('log', `Restarting server: ${serverPath}`);
                const cleanEnv = {
                    PATH: process.env.PATH,
                    NODE_PATH: process.env.NODE_PATH,
                    TELEGRAM_CLEAR_UPDATES: '1' // Add marker to indicate this is a restart
                };
                if (chatId) cleanEnv.RESTART_NOTIFY_CHATID = chatId.toString();
                const child = spawn(process.execPath, [serverPath], { detached: true, stdio: 'inherit', env: cleanEnv });
                child.unref();
                process.exit(0);
            }, 1000);
        }
    }).catch(err => {
        logWithTimestamp('error', 'Error stopping Telegram Bot polling:', err);
        // Continue restart process even on error
        if (wss) {
            wss.close(() => {
                // Restart code...
                setTimeout(() => {
                    const { spawn } = require('child_process');
                    const serverPath = path.join(__dirname, 'server.js');
                    logWithTimestamp('log', `Restarting server: ${serverPath}`);
                    const cleanEnv = {
                        PATH: process.env.PATH,
                        NODE_PATH: process.env.NODE_PATH,
                        TELEGRAM_CLEAR_UPDATES: '1' // Add marker to indicate this is a restart
                    };
                    if (chatId) cleanEnv.RESTART_NOTIFY_CHATID = chatId.toString();
                    const child = spawn(process.execPath, [serverPath], { detached: true, stdio: 'inherit', env: cleanEnv });
                    child.unref();
                    process.exit(0);
                }, 1000);
            });
        } else {
            // If no WebSocket server, restart directly
            setTimeout(() => {
                const { spawn } = require('child_process');
                const serverPath = path.join(__dirname, 'server.js');
                logWithTimestamp('log', `Restarting server: ${serverPath}`);
                const cleanEnv = {
                    PATH: process.env.PATH,
                    NODE_PATH: process.env.NODE_PATH,
                    TELEGRAM_CLEAR_UPDATES: '1' // Add marker to indicate this is a restart
                };
                if (chatId) cleanEnv.RESTART_NOTIFY_CHATID = chatId.toString();
                const child = spawn(process.execPath, [serverPath], { detached: true, stdio: 'inherit', env: cleanEnv });
                child.unref();
                process.exit(0);
            }, 1000);
        }
    });
}

// Exit server function
function exitServer() {
    logWithTimestamp('log', 'Shutting down server...');
    const forceExitTimeout = setTimeout(() => {
        logWithTimestamp('error', 'Exit operation timeout, forcing process exit');
        process.exit(1);
    }, 10000);
    try {
        if (fs.existsSync(RESTART_PROTECTION_FILE)) {
            fs.unlinkSync(RESTART_PROTECTION_FILE);
            logWithTimestamp('log', 'Restart protection file cleaned up');
        }
    } catch (error) {
        logWithTimestamp('error', 'Failed to clean up restart protection file:', error);
    }
    const finalExit = () => {
        clearTimeout(forceExitTimeout);
        logWithTimestamp('log', 'Server-side component successfully shut down');
        process.exit(0);
    };
    if (wss) {
        wss.close(() => {
            logWithTimestamp('log', 'WebSocket server closed');
            bot.stopPolling().finally(finalExit);
        });
    } else {
        bot.stopPolling().finally(finalExit);
    }
}

function handleSystemCommand(command, chatId) {
    logWithTimestamp('log', `Executing system command: ${command}`);

    // Handle ping command - return connection status information
    if (command === 'ping') {
        const bridgeStatus = 'Bridge status: Connected ✅';
        const stStatus = sillyTavernClient && sillyTavernClient.readyState === WebSocket.OPEN ?
            'SillyTavern status: Connected ✅' :
            'SillyTavern status: Not connected ❌';
        bot.sendMessage(chatId, `${bridgeStatus}\n${stStatus}`);
        return;
    }

    let responseMessage = '';
    switch (command) {
        case 'reload':
            responseMessage = 'Reloading server-side component...';
            // If SillyTavern is connected, refresh UI
            if (sillyTavernClient && sillyTavernClient.readyState === WebSocket.OPEN) {
                sillyTavernClient.commandToExecuteOnClose = { command, chatId };
                sillyTavernClient.send(JSON.stringify({ type: 'system_command', command: 'reload_ui_only', chatId }));
            } else {
                // If not connected, reload server directly
                bot.sendMessage(chatId, responseMessage);
                reloadServer(chatId);
            }
            break;
        case 'restart':
            responseMessage = 'Restarting server-side component...';
            // If SillyTavern is connected, refresh UI
            if (sillyTavernClient && sillyTavernClient.readyState === WebSocket.OPEN) {
                sillyTavernClient.commandToExecuteOnClose = { command, chatId };
                sillyTavernClient.send(JSON.stringify({ type: 'system_command', command: 'reload_ui_only', chatId }));
            } else {
                // If not connected, restart server directly
                bot.sendMessage(chatId, responseMessage);
                restartServer(chatId);
            }
            break;
        case 'exit':
            responseMessage = 'Shutting down server-side component...';
            // If SillyTavern is connected, refresh UI
            if (sillyTavernClient && sillyTavernClient.readyState === WebSocket.OPEN) {
                sillyTavernClient.commandToExecuteOnClose = { command, chatId };
                sillyTavernClient.send(JSON.stringify({ type: 'system_command', command: 'reload_ui_only', chatId }));
            } else {
                // If not connected, exit server directly
                bot.sendMessage(chatId, responseMessage);
                exitServer();
            }
            break;
        default:
            logWithTimestamp('warn', `Unknown system command: ${command}`);
            bot.sendMessage(chatId, `Unknown system command: /${command}`);
            return;
    }

    // Only send response message if SillyTavern is connected
    // Messages are only sent in the above switch statement when SillyTavern is connected
    if (sillyTavernClient && sillyTavernClient.readyState === WebSocket.OPEN) {
        bot.sendMessage(chatId, responseMessage);
    }
}

// Handle Telegram commands
async function handleTelegramCommand(command, args, chatId) {
    logWithTimestamp('log', `Handling Telegram command: /${command} ${args.join(' ')}`);

    // Show "typing" status
    bot.sendChatAction(chatId, 'typing').catch(error =>
        logWithTimestamp('error', 'Failed to send "typing" status:', error));

    // Default reply
    let replyText = `Unknown command: /${command}. Use /help to see all commands.`;

    // Special handling for help command, can be shown regardless of SillyTavern connection
    if (command === 'help') {
        replyText = `SillyTavern Telegram Bridge Commands:\n\n`;
        replyText += `Chat Management\n`;
        replyText += `/new - Start a new chat with the current character.\n`;
        replyText += `/listchats - List all saved chat logs for the current character.\n`;
        replyText += `/switchchat <chat_name> - Load a specific chat log.\n`;
        replyText += `/switchchat_<number> - Load chat log by number.\n\n`;
        replyText += `Character Management\n`;
        replyText += `/listchars - List all available characters.\n`;
        replyText += `/switchchar <char_name> - Switch to specified character.\n`;
        replyText += `/switchchar_<number> - Switch character by number.\n\n`;
        replyText += `System Management\n`;
        replyText += `/reload - Reload plugin's server-side component and refresh ST webpage.\n`;
        replyText += `/restart - Refresh ST webpage and restart plugin's server-side component.\n`;
        replyText += `/exit - Exit plugin's server-side component.\n`;
        replyText += `/ping - Check connection status.\n\n`;
        replyText += `Help\n`;
        replyText += `/help - Show this help message.`;

        // Send help message and return
        bot.sendMessage(chatId, replyText).catch(err => {
            logWithTimestamp('error', `Failed to send command reply: ${err.message}`);
        });
        return;
    }

    // Check if SillyTavern is connected
    if (!sillyTavernClient || sillyTavernClient.readyState !== WebSocket.OPEN) {
        bot.sendMessage(chatId, 'SillyTavern not connected, cannot execute character and chat related commands. Please ensure SillyTavern is open and Telegram extension is enabled.');
        return;
    }

    // Handle by command type
    switch (command) {
        case 'new':
            // Send command to frontend for execution
            sillyTavernClient.send(JSON.stringify({
                type: 'execute_command',
                command: 'new',
                chatId: chatId
            }));
            return; // Frontend will send response, so return directly here
        case 'listchars':
            // Send command to frontend for execution
            sillyTavernClient.send(JSON.stringify({
                type: 'execute_command',
                command: 'listchars',
                chatId: chatId
            }));
            return;
        case 'switchchar':
            if (args.length === 0) {
                replyText = 'Please provide character name or number. Usage: /switchchar <character name> or /switchchar_number';
            } else {
                // Send command to frontend for execution
                sillyTavernClient.send(JSON.stringify({
                    type: 'execute_command',
                    command: 'switchchar',
                    args: args,
                    chatId: chatId
                }));
                return;
            }
            break;
        case 'listchats':
            // Send command to frontend for execution
            sillyTavernClient.send(JSON.stringify({
                type: 'execute_command',
                command: 'listchats',
                chatId: chatId
            }));
            return;
        case 'switchchat':
            if (args.length === 0) {
                replyText = 'Please provide chat log name. Usage: /switchchat <chat log name>';
            } else {
                // Send command to frontend for execution
                sillyTavernClient.send(JSON.stringify({
                    type: 'execute_command',
                    command: 'switchchat',
                    args: args,
                    chatId: chatId
                }));
                return;
            }
            break;
        default:
            // Handle special format commands like switchchar_1, switchchat_2, etc.
            const charMatch = command.match(/^switchchar_(\d+)$/);
            if (charMatch) {
                // Send command to frontend for execution
                sillyTavernClient.send(JSON.stringify({
                    type: 'execute_command',
                    command: command, // Keep original command format
                    chatId: chatId
                }));
                return;
            }

            const chatMatch = command.match(/^switchchat_(\d+)$/);
            if (chatMatch) {
                // Send command to frontend for execution
                sillyTavernClient.send(JSON.stringify({
                    type: 'execute_command',
                    command: command, // Keep original command format
                    chatId: chatId
                }));
                return;
            }
    }

    // Send reply
    bot.sendMessage(chatId, replyText).catch(err => {
        logWithTimestamp('error', `Failed to send command reply: ${err.message}`);
    });
}

// --- WebSocket Server Logic ---
wss.on('connection', ws => {
    logWithTimestamp('log', 'SillyTavern extension connected!');
    sillyTavernClient = ws;

    ws.on('message', async (message) => { // Set entire callback as async
        let data; // Declare data outside try block
        try {
            data = JSON.parse(message);

            // --- Handle streaming text chunks ---
            if (data.type === 'stream_chunk' && data.chatId) {
                let session = ongoingStreams.get(data.chatId);

                // 1. If session doesn't exist, immediately create a placeholder session synchronously, create session and messagePromise
                if (!session) {
                    // Declare with let to access inside Promise
                    let resolveMessagePromise;
                    const messagePromise = new Promise(resolve => {
                        resolveMessagePromise = resolve;
                    });

                    session = {
                        messagePromise: messagePromise,
                        lastText: data.text,
                        timer: null,
                        isEditing: false, // Add status lock
                    };
                    ongoingStreams.set(data.chatId, session);

                    // Asynchronously send first message and update session
                    bot.sendMessage(data.chatId, 'Thinking...')
                        .then(sentMessage => {
                            // When message is sent successfully, resolve Promise and pass messageId
                            resolveMessagePromise(sentMessage.message_id);
                        }).catch(err => {
                            logWithTimestamp('error', 'Failed to send initial Telegram message:', err);
                            ongoingStreams.delete(data.chatId); // Clean up on error
                        });
                } else {
                    // 2. If session exists, only update latest text
                    session.lastText = data.text;
                }

                // 3. Try to trigger one edit (throttling protection)
                // Ensure messageId is obtained and no edit or timer is currently in progress
                // Use await messagePromise to ensure messageId is available
                const messageId = await session.messagePromise;

                if (messageId && !session.isEditing && !session.timer) {
                    session.timer = setTimeout(async () => { // Set timer callback as async too
                        const currentSession = ongoingStreams.get(data.chatId);
                        if (currentSession) {
                            const currentMessageId = await currentSession.messagePromise;
                            if (currentMessageId) {
                                currentSession.isEditing = true;
                                bot.editMessageText(currentSession.lastText + ' ...', {
                                    chat_id: data.chatId,
                                    message_id: currentMessageId,
                                }).catch(err => {
                                    if (!err.message.includes('message is not modified'))
                                        logWithTimestamp('error', 'Failed to edit Telegram message:', err.message);
                                }).finally(() => {
                                    if (ongoingStreams.has(data.chatId)) ongoingStreams.get(data.chatId).isEditing = false;
                                });
                            }
                            currentSession.timer = null;
                        }
                    }, 2000);
                }
                return;
            }

            // --- Handle stream end signal ---
            if (data.type === 'stream_end' && data.chatId) {
                const session = ongoingStreams.get(data.chatId);
                // Only process if session exists, indicating this is indeed streaming
                if (session) {
                    if (session.timer) {
                        clearTimeout(session.timer);
                    }
                    logWithTimestamp('log', `Received stream end signal, waiting for final rendered text update...`);
                    // Note: We don't clean up session here, wait for final_message_update instead
                }
                // If session doesn't exist but stream_end is received, this is an abnormal situation
                // Session may have been cleaned up prematurely for some reason
                else {
                    logWithTimestamp('warn', `Received stream end signal, but cannot find corresponding session for ChatID ${data.chatId}`);
                    // For safety, still send message, but this situation shouldn't happen
                    await bot.sendMessage(data.chatId, data.text || "Message generation complete").catch(err => {
                        logWithTimestamp('error', 'Failed to send stream end message:', err.message);
                    });
                }
                return;
            }

            // --- Handle final message update after rendering ---
            if (data.type === 'final_message_update' && data.chatId) {
                const session = ongoingStreams.get(data.chatId);

                // If session exists, this is the final update of streaming
                if (session) {
                    // Use await messagePromise
                    const messageId = await session.messagePromise;
                    if (messageId) {
                        logWithTimestamp('log', `Received final streamed rendered text, updating message ${messageId}`);
                        await bot.editMessageText(data.text, {
                            chat_id: data.chatId,
                            message_id: messageId,
                            // Optional: specify parse_mode: 'MarkdownV2' or 'HTML' here
                            // parse_mode: 'HTML',
                        }).catch(err => {
                            if (!err.message.includes('message is not modified'))
                                logWithTimestamp('error', 'Failed to edit final formatted Telegram message:', err.message);
                        });
                        logWithTimestamp('log', `Streaming pre-final update sent for ChatID ${data.chatId}.`);
                    } else {
                        logWithTimestamp('warn', `Received final_message_update, but messageId from streaming session could not be obtained.`);
                    }
                    // Clean up streaming session
                    ongoingStreams.delete(data.chatId);
                    logWithTimestamp('log', `Streaming session for ChatID ${data.chatId} completed and cleaned up.`);
                }
                // If session doesn't exist, this is a complete non-streaming reply
                // Note: This shouldn't happen as we've fixed this on the client side
                // But for robustness, we still keep this handling
                else {
                    logWithTimestamp('log', `Received non-streaming complete reply, sending new message directly to ChatID ${data.chatId}`);
                    await bot.sendMessage(data.chatId, data.text, {
                        // Optional: specify parse_mode here
                    }).catch(err => {
                        logWithTimestamp('error', 'Failed to send non-streaming complete reply:', err.message);
                    });
                }
                return;
            }

            // --- Other message handling logic ---
            if (data.type === 'error_message' && data.chatId) {
                logWithTimestamp('error', `Received error report from SillyTavern, sending to Telegram user ${data.chatId}: ${data.text}`);
                bot.sendMessage(data.chatId, data.text);
            } else if (data.type === 'ai_reply' && data.chatId) {
                logWithTimestamp('log', `Received non-streaming AI reply, sending to Telegram user ${data.chatId}`);
                // Ensure cleaning up any existing streaming session before sending message
                if (ongoingStreams.has(data.chatId)) {
                    logWithTimestamp('log', `Cleaning up streaming session for ChatID ${data.chatId} because non-streaming reply was received`);
                    ongoingStreams.delete(data.chatId);
                }
                // Send non-streaming reply
                await bot.sendMessage(data.chatId, data.text).catch(err => {
                    logWithTimestamp('error', `Failed to send non-streaming AI reply: ${err.message}`);
                });
            } else if (data.type === 'typing_action' && data.chatId) {
                logWithTimestamp('log', `Showing "typing" status to Telegram user ${data.chatId}`);
                bot.sendChatAction(data.chatId, 'typing').catch(error =>
                    logWithTimestamp('error', 'Failed to send "typing" status:', error));
            } else if (data.type === 'command_executed') {
                // Handle frontend command execution result
                logWithTimestamp('log', `Command ${data.command} execution completed, result: ${data.success ? 'success' : 'failure'}`);
                if (data.message) {
                    logWithTimestamp('log', `Command execution message: ${data.message}`);
                }
            }
        } catch (error) {
            logWithTimestamp('error', 'Error processing SillyTavern message:', error);
            // Ensure cleanup even when JSON parsing fails
            if (data && data.chatId) {
                ongoingStreams.delete(data.chatId);
            }
        }
    });

    ws.on('close', () => {
        logWithTimestamp('log', 'SillyTavern extension disconnected.');
        if (ws.commandToExecuteOnClose) {
            const { command, chatId } = ws.commandToExecuteOnClose;
            logWithTimestamp('log', `Client disconnected, now executing scheduled command: ${command}`);
            if (command === 'reload') reloadServer(chatId);
            if (command === 'restart') restartServer(chatId);
            if (command === 'exit') exitServer(chatId);
        }
        sillyTavernClient = null;
        ongoingStreams.clear();
    });

    ws.on('error', (error) => {
        logWithTimestamp('error', 'WebSocket error occurred:', error);
        if (sillyTavernClient) {
            sillyTavernClient.commandToExecuteOnClose = null; // Clear marker to prevent accidental execution
        }
        sillyTavernClient = null;
        ongoingStreams.clear();
    });
});

// Check if restart completion notification needs to be sent
if (process.env.RESTART_NOTIFY_CHATID) {
    const chatId = parseInt(process.env.RESTART_NOTIFY_CHATID);
    if (!isNaN(chatId)) {
        setTimeout(() => {
            bot.sendMessage(chatId, 'Server-side component successfully restarted and ready')
                .catch(err => logWithTimestamp('error', 'Failed to send restart notification:', err))
                .finally(() => {
                    delete process.env.RESTART_NOTIFY_CHATID;
                });
        }, 2000);
    }
}

// Listen for Telegram messages
bot.on('message', (msg) => {
    const chatId = msg.chat.id;
    const text = msg.text;
    const userId = msg.from.id;
    const username = msg.from.username || 'N/A';

    // Check if whitelist is configured and not empty
    if (config.allowedUserIds && config.allowedUserIds.length > 0) {
        // If current user's ID is not in whitelist
        if (!config.allowedUserIds.includes(userId)) {
            logWithTimestamp('log', `Rejected access from non-whitelisted user:\n  - User ID: ${userId}\n  - Username: @${username}\n  - Chat ID: ${chatId}\n  - Message: "${text}"`);
            // Send rejection message to this user
            bot.sendMessage(chatId, 'Sorry, you are not authorized to use this bot.').catch(err => {
                logWithTimestamp('error', `Failed to send rejection message to ${chatId}:`, err.message);
            });
            // Terminate further processing
            return;
        }
    }

    if (!text) return;

    if (text.startsWith('/')) {
        const parts = text.slice(1).trim().split(/\s+/);
        const command = parts[0].toLowerCase();
        const args = parts.slice(1);

        // System commands are handled directly by server
        if (['reload', 'restart', 'exit', 'ping'].includes(command)) {
            handleSystemCommand(command, chatId);
            return;
        }

        // Other commands are also handled by server, but may need frontend execution
        handleTelegramCommand(command, args, chatId);
        return;
    }

    // Handle regular messages
    if (sillyTavernClient && sillyTavernClient.readyState === WebSocket.OPEN) {
        logWithTimestamp('log', `Received message from Telegram user ${chatId}: "${text}"`);
        const payload = JSON.stringify({ type: 'user_message', chatId, text });
        sillyTavernClient.send(payload);
    } else {
        logWithTimestamp('warn', 'Received Telegram message, but SillyTavern extension is not connected.');
        bot.sendMessage(chatId, 'Sorry, I cannot connect to SillyTavern right now. Please ensure SillyTavern is open and the Telegram extension is enabled.');
    }
});