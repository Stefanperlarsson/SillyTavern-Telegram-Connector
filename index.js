// index.js
// SillyTavern Telegram Connector Extension
// Handles communication between SillyTavern and the Telegram Bridge server
// Supports bot-per-character architecture with queued request processing

// Only destructure properties that actually exist in the object returned by getContext()
const {
    extensionSettings,
    deleteLastMessage,
    saveSettingsDebounced,
} = SillyTavern.getContext();

// Import all needed public API functions from script.js
import {
    eventSource,
    event_types,
    getPastCharacterChats,
    sendMessageAsUser,
    doNewChat,
    selectCharacterById,
    openCharacterChat,
    Generate,
    setExternalAbortController,
} from "../../../../script.js";

// ============================================================================
// CONSTANTS & CONFIGURATION
// ============================================================================

const MODULE_NAME = 'SillyTavern-Telegram-Connector';
const DEFAULT_SETTINGS = {
    bridgeUrl: 'ws://127.0.0.1:2333',
    autoConnect: true,
};

// ============================================================================
// STATE MANAGEMENT
// ============================================================================

/** @type {WebSocket|null} */
let ws = null;

/**
 * @typedef {Object} ActiveRequest
 * @property {number} chatId - Telegram chat ID
 * @property {string} botId - Bot identifier
 * @property {string} characterName - Character being used
 * @property {boolean} isStreaming - Whether streaming is active
 */

/** @type {ActiveRequest|null} */
let activeRequest = null;

// ============================================================================
// UTILITY FUNCTIONS
// ============================================================================

/**
 * Gets the extension settings, initializing with defaults if needed
 * @returns {Object} Extension settings
 */
function getSettings() {
    if (!extensionSettings[MODULE_NAME]) {
        extensionSettings[MODULE_NAME] = { ...DEFAULT_SETTINGS };
    }
    return extensionSettings[MODULE_NAME];
}

/**
 * Updates the connection status display in the UI
 * @param {string} message - Status message to display
 * @param {string} color - CSS color for the status text
 */
function updateStatus(message, color) {
    const statusEl = document.getElementById('telegram_connection_status');
    if (statusEl) {
        statusEl.textContent = `Status: ${message}`;
        statusEl.style.color = color;
    }
}

/**
 * Reloads the current page
 */
function reloadPage() {
    window.location.reload();
}

/**
 * Logs a message with the Telegram Bridge prefix
 * @param {'log' | 'error' | 'warn'} level - Log level
 * @param {...any} args - Arguments to log
 */
function log(level, ...args) {
    const prefix = '[Telegram Bridge]';
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
// CHARACTER MANAGEMENT
// ============================================================================

/**
 * Finds a character by name and returns its index
 * @param {string} characterName - Name of the character to find
 * @returns {{found: boolean, index: number, message: string}} Result object
 */
function findCharacterByName(characterName) {
    const context = SillyTavern.getContext();
    const characters = context.characters;

    // Find the character by exact name match
    const targetChar = characters.find(c => c.name === characterName);

    if (targetChar) {
        const charIndex = characters.indexOf(targetChar);
        return {
            found: true,
            index: charIndex,
            message: `Found character "${characterName}" at index ${charIndex}`
        };
    }

    // Try case-insensitive search
    const targetCharCI = characters.find(c => c.name.toLowerCase() === characterName.toLowerCase());
    if (targetCharCI) {
        const charIndex = characters.indexOf(targetCharCI);
        return {
            found: true,
            index: charIndex,
            message: `Found character "${targetCharCI.name}" at index ${charIndex} (case-insensitive match)`
        };
    }

    return {
        found: false,
        index: -1,
        message: `Character "${characterName}" not found. Please check the character name in your bot configuration.`
    };
}

/**
 * Checks if the currently selected character matches the expected name
 * @param {string} characterName - Expected character name
 * @returns {boolean} True if the current character matches
 */
function isCurrentCharacter(characterName) {
    const context = SillyTavern.getContext();
    if (context.characterId === undefined || context.characterId === null) {
        return false;
    }
    const currentChar = context.characters[context.characterId];
    if (!currentChar) {
        return false;
    }
    return currentChar.name === characterName ||
           currentChar.name.toLowerCase() === characterName.toLowerCase();
}

/**
 * Switches to a character by name, handling the queue protocol
 * @param {string} characterName - Name of the character to switch to
 * @param {number} chatId - Telegram chat ID
 * @param {string} botId - Bot identifier
 * @param {boolean} isQueuedSwitch - Whether this is part of queue processing
 * @returns {Promise<{success: boolean, message: string}>}
 */
async function switchToCharacter(characterName, chatId, botId, isQueuedSwitch) {
    // Check if we're already on the correct character
    if (isCurrentCharacter(characterName)) {
        log('log', `Already on character "${characterName}", no switch needed`);
        return {
            success: true,
            message: `Already chatting with ${characterName}.`
        };
    }

    // Find the character
    const searchResult = findCharacterByName(characterName);
    if (!searchResult.found) {
        log('error', searchResult.message);
        return {
            success: false,
            message: searchResult.message
        };
    }

    // Perform the switch
    try {
        log('log', `Switching to character "${characterName}" (index: ${searchResult.index})`);
        await selectCharacterById(searchResult.index);
        log('log', `Successfully switched to character "${characterName}"`);
        return {
            success: true,
            message: `Switched to ${characterName}.`
        };
    } catch (error) {
        log('error', `Failed to switch to character "${characterName}":`, error);
        return {
            success: false,
            message: `Failed to switch to ${characterName}: ${error.message}`
        };
    }
}

// ============================================================================
// WEBSOCKET CONNECTION
// ============================================================================

/**
 * Establishes a WebSocket connection to the bridge server
 */
function connect() {
    if (ws && ws.readyState === WebSocket.OPEN) {
        log('log', 'Already connected');
        return;
    }

    const settings = getSettings();
    if (!settings.bridgeUrl) {
        updateStatus('URL not set!', 'red');
        return;
    }

    updateStatus('Connecting...', 'orange');
    log('log', `Connecting to ${settings.bridgeUrl}...`);

    ws = new WebSocket(settings.bridgeUrl);

    ws.onopen = () => {
        log('log', 'Connection successful!');
        updateStatus('Connected', 'green');
    };

    ws.onmessage = handleWebSocketMessage;

    ws.onclose = () => {
        log('log', 'Connection closed.');
        updateStatus('Disconnected', 'red');
        ws = null;
        activeRequest = null;
    };

    ws.onerror = (error) => {
        log('error', 'WebSocket error:', error);
        updateStatus('Connection error', 'red');
        ws = null;
        activeRequest = null;
    };
}

/**
 * Closes the WebSocket connection
 */
function disconnect() {
    if (ws) {
        ws.close();
    }
}

/**
 * Sends a message through the WebSocket if connected
 * @param {Object} payload - The message payload to send
 */
function sendToServer(payload) {
    if (ws && ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify(payload));
    } else {
        log('warn', 'Cannot send message: WebSocket not connected');
    }
}

// ============================================================================
// MESSAGE HANDLING
// ============================================================================

/**
 * Handles incoming WebSocket messages from the server
 * @param {MessageEvent} event - WebSocket message event
 */
async function handleWebSocketMessage(event) {
    let data;
    try {
        data = JSON.parse(event.data);

        // --- Execute Command (including character switches) ---
        if (data.type === 'execute_command') {
            await handleExecuteCommand(data);
            return;
        }

        // --- User Message (generation request) ---
        if (data.type === 'user_message') {
            await handleUserMessage(data);
            return;
        }

    } catch (error) {
        log('error', 'Error processing message:', error);
        if (data && data.chatId && data.botId) {
            sendToServer({
                type: 'error_message',
                chatId: data.chatId,
                botId: data.botId,
                text: 'An internal error occurred while processing your request.'
            });
        }
    }
}

/**
 * Handles execute_command messages from the server
 * @param {Object} data - Command data from server
 */
async function handleExecuteCommand(data) {
    log('log', `Executing command: ${data.command}`, data);

    const chatId = data.chatId;
    const botId = data.botId;
    const isQueuedSwitch = data.isQueuedSwitch || false;

    // Send typing indicator
    sendToServer({ type: 'typing_action', chatId, botId });

    const context = SillyTavern.getContext();
    let result = { success: false, message: 'Unknown command' };

    try {
        switch (data.command) {
            // --- New Chat ---
            case 'new':
                await doNewChat({ deleteCurrentChat: false });
                result = {
                    success: true,
                    message: 'New chat has been started.'
                };
                break;

            // --- List Chats ---
            case 'listchats':
                if (context.characterId === undefined) {
                    result = {
                        success: false,
                        message: 'No character selected.'
                    };
                } else {
                    const chatFiles = await getPastCharacterChats(context.characterId);
                    if (chatFiles.length > 0) {
                        let replyText = 'Chat logs for current character:\n\n';
                        chatFiles.forEach((chat, index) => {
                            const chatName = chat.file_name.replace('.jsonl', '');
                            replyText += `${index + 1}. /switchchat_${index + 1} - ${chatName}\n`;
                        });
                        replyText += '\nUse /switchchat_<number> or /switchchat <name> to switch chats';
                        result = { success: true, message: replyText };
                    } else {
                        result = {
                            success: true,
                            message: 'No chat logs found for this character.'
                        };
                    }
                }
                break;

            // --- Switch Chat by Name ---
            case 'switchchat':
                if (!data.args || data.args.length === 0) {
                    result = {
                        success: false,
                        message: 'Please provide a chat log name.'
                    };
                } else {
                    const targetChatFile = data.args.join(' ');
                    try {
                        await openCharacterChat(targetChatFile);
                        result = {
                            success: true,
                            message: `Loaded chat log: ${targetChatFile}`
                        };
                    } catch (err) {
                        log('error', 'Failed to load chat:', err);
                        result = {
                            success: false,
                            message: `Failed to load chat log "${targetChatFile}".`
                        };
                    }
                }
                break;

            default:
                // Handle numbered commands (switchchat_N)
                const chatMatch = data.command.match(/^switchchat_(\d+)$/);
                if (chatMatch) {
                    if (context.characterId === undefined) {
                        result = {
                            success: false,
                            message: 'No character selected.'
                        };
                    } else {
                        const index = parseInt(chatMatch[1]) - 1;
                        const chatFiles = await getPastCharacterChats(context.characterId);

                        if (index >= 0 && index < chatFiles.length) {
                            const targetChat = chatFiles[index];
                            const chatName = targetChat.file_name.replace('.jsonl', '');
                            try {
                                await openCharacterChat(chatName);
                                result = {
                                    success: true,
                                    message: `Loaded chat log: ${chatName}`
                                };
                            } catch (err) {
                                log('error', 'Failed to load chat:', err);
                                result = {
                                    success: false,
                                    message: 'Failed to load chat log.'
                                };
                            }
                        } else {
                            result = {
                                success: false,
                                message: `Invalid chat log number: ${index + 1}. Use /listchats to see available chats.`
                            };
                        }
                    }
                    break;
                }

                result = {
                    success: false,
                    message: `Unknown command: ${data.command}`
                };
        }
    } catch (error) {
        log('error', 'Command execution error:', error);
        result = {
            success: false,
            message: `Error executing command: ${error.message}`
        };
    }

    // Send command result back to server
    sendToServer({
        type: 'command_executed',
        command: data.command,
        success: result.success,
        message: result.message,
        chatId: chatId,
        botId: botId,
        characterName: data.characterName || data.args?.[0],
        isQueuedSwitch: isQueuedSwitch
    });
}

/**
 * Handles user message generation requests
 * @param {Object} data - Message data from server
 */
async function handleUserMessage(data) {
    log('log', 'Received user message for generation', data);

    const chatId = data.chatId;
    const botId = data.botId;
    const characterName = data.characterName;

    // Set up active request tracking
    activeRequest = {
        chatId: chatId,
        botId: botId,
        characterName: characterName,
        isStreaming: false
    };

    // Send typing indicator
    sendToServer({ type: 'typing_action', chatId, botId });

    // Add user message to SillyTavern
    await sendMessageAsUser(data.text);

    // Set up streaming callback
    const streamCallback = (cumulativeText) => {
        if (activeRequest) {
            activeRequest.isStreaming = true;
            sendToServer({
                type: 'stream_chunk',
                chatId: activeRequest.chatId,
                botId: activeRequest.botId,
                text: cumulativeText,
            });
        }
    };
    eventSource.on(event_types.STREAM_TOKEN_RECEIVED, streamCallback);

    // Define cleanup function
    let errorOccurred = false;
    const cleanup = () => {
        eventSource.removeListener(event_types.STREAM_TOKEN_RECEIVED, streamCallback);
        if (activeRequest && activeRequest.isStreaming && !errorOccurred) {
            sendToServer({
                type: 'stream_end',
                chatId: activeRequest.chatId,
                botId: activeRequest.botId
            });
        }
    };

    // Listen for generation end events (once to avoid interference)
    eventSource.once(event_types.GENERATION_ENDED, cleanup);
    eventSource.once(event_types.GENERATION_STOPPED, cleanup);

    // Trigger generation
    try {
        log('log', 'Starting Generate() call...');
        const abortController = new AbortController();
        setExternalAbortController(abortController);
        await Generate('normal', { signal: abortController.signal });
        log('log', 'Generate() call completed');
    } catch (error) {
        log('error', 'Generate() error:', error);
        errorOccurred = true;

        // Delete the user message that caused the error
        await deleteLastMessage();
        log('log', 'Deleted user message that caused the error.');

        // Send error message
        const errorMessage = `Sorry, an error occurred while generating a reply.\nYour previous message has been retracted, please retry or send different content.\n\nError details: ${error.message || 'Unknown error'}`;

        if (activeRequest) {
            sendToServer({
                type: 'error_message',
                chatId: activeRequest.chatId,
                botId: activeRequest.botId,
                text: errorMessage,
            });
        }

        cleanup();
        activeRequest = null;
    }
}

// ============================================================================
// FINAL MESSAGE HANDLING
// ============================================================================

/**
 * Handles the final message after generation completes
 * Extracts rendered text from the DOM and sends it to the server
 * @param {number} lastMessageIdInChatArray - Index of the last message in the chat array
 */
function handleFinalMessage(lastMessageIdInChatArray) {
    log('log', `handleFinalMessage called with index: ${lastMessageIdInChatArray}, activeRequest:`, activeRequest);
    
    // Ensure we have an active request to respond to
    if (!ws || ws.readyState !== WebSocket.OPEN || !activeRequest) {
        log('warn', `handleFinalMessage early return - ws: ${!!ws}, wsOpen: ${ws?.readyState === WebSocket.OPEN}, activeRequest: ${!!activeRequest}`);
        return;
    }

    const lastMessageIndex = lastMessageIdInChatArray - 1;
    if (lastMessageIndex < 0) return;

    // Small delay to ensure DOM update is complete
    setTimeout(() => {
        const context = SillyTavern.getContext();
        const lastMessage = context.chat[lastMessageIndex];

        // Confirm this is the AI reply we just triggered
        if (lastMessage && !lastMessage.is_user && !lastMessage.is_system) {
            const messageElement = $(`#chat .mes[mesid="${lastMessageIndex}"]`);

            if (messageElement.length > 0) {
                const messageTextElement = messageElement.find('.mes_text');

                // Get HTML content and convert to plain text
                let renderedText = messageTextElement.html()
                    .replace(/<br\s*\/?>/gi, '\n')
                    .replace(/<\/p>\s*<p>/gi, '\n\n');

                // Decode HTML entities
                const tempDiv = document.createElement('div');
                tempDiv.innerHTML = renderedText;
                renderedText = tempDiv.textContent;

                log('log', `Sending final message to bot ${activeRequest.botId}`);

                // Send appropriate message type based on streaming state
                if (activeRequest.isStreaming) {
                    sendToServer({
                        type: 'final_message_update',
                        chatId: activeRequest.chatId,
                        botId: activeRequest.botId,
                        text: renderedText,
                    });
                } else {
                    sendToServer({
                        type: 'ai_reply',
                        chatId: activeRequest.chatId,
                        botId: activeRequest.botId,
                        text: renderedText,
                    });
                }

                // Clear active request
                activeRequest = null;
            }
        }
    }, 100);
}

// Register global event listeners for final message handling
eventSource.on(event_types.GENERATION_ENDED, handleFinalMessage);
eventSource.on(event_types.GENERATION_STOPPED, handleFinalMessage);

// ============================================================================
// EXTENSION INITIALIZATION
// ============================================================================

jQuery(async () => {
    log('log', 'Loading settings UI...');
    try {
        const settingsHtml = await $.get(`/scripts/extensions/third-party/${MODULE_NAME}/settings.html`);
        $('#extensions_settings').append(settingsHtml);
        log('log', 'Settings UI loaded.');

        const settings = getSettings();
        $('#telegram_bridge_url').val(settings.bridgeUrl);
        $('#telegram_auto_connect').prop('checked', settings.autoConnect);

        // Bridge URL input handler
        $('#telegram_bridge_url').on('input', () => {
            const settings = getSettings();
            settings.bridgeUrl = $('#telegram_bridge_url').val();
            saveSettingsDebounced();
        });

        // Auto-connect checkbox handler
        $('#telegram_auto_connect').on('change', function () {
            const settings = getSettings();
            settings.autoConnect = $(this).prop('checked');
            log('log', `Auto-connect setting changed to: ${settings.autoConnect}`);
            saveSettingsDebounced();
        });

        // Button handlers
        $('#telegram_connect_button').on('click', connect);
        $('#telegram_disconnect_button').on('click', disconnect);

        // Auto-connect if enabled
        if (settings.autoConnect) {
            log('log', 'Auto-connect enabled, connecting...');
            connect();
        }

    } catch (error) {
        log('error', 'Failed to load settings HTML:', error);
    }
    log('log', 'Extension loaded.');
});
