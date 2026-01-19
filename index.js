// index.js
// SillyTavern Telegram Connector Extension
// Handles communication between SillyTavern and the Telegram Bridge server
// Supports bot-per-character architecture with queued request processing

// Only destructure properties that actually exist in the object returned by getContext()
const {
    extensionSettings,
    deleteLastMessage,
    saveSettingsDebounced,
    executeSlashCommands,
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
    appendMediaToMessage,
    generateQuietPrompt,
} from "../../../../script.js";

// Import World Info functions for summarization feature
import {
    world_names,
    loadWorldInfo,
    saveWorldInfo,
    createWorldInfoEntry,
} from "../../../../scripts/world-info.js";

// Import utility functions for file handling
import {
    saveBase64AsFile,
} from "../../../utils.js";

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
 * @typedef {Object} MediaItem
 * @property {string} type - Media type ('image', 'video', 'audio')
 * @property {string} url - Media URL (relative path or base64)
 * @property {string} [title] - Optional title/prompt
 */

/**
 * @typedef {Object} ActiveRequest
 * @property {number} chatId - Telegram chat ID
 * @property {string} botId - Bot identifier
 * @property {string} characterName - Character being used
 * @property {boolean} isStreaming - Whether streaming is active
 * @property {number} startMessageIndex - Chat index when request started
 * @property {MediaItem[]} collectedMedia - Media collected during this request
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
// IMAGE HANDLING
// ============================================================================

/**
 * Fetches an image from a URL and converts it to base64
 * @param {string} imageUrl - The image URL (relative or absolute)
 * @returns {Promise<{base64: string, mimeType: string}|null>} Base64 data or null on error
 */
async function fetchImageAsBase64(imageUrl) {
    try {
        // Handle relative URLs by prepending the origin
        const fullUrl = imageUrl.startsWith('/')
            ? `${window.location.origin}${imageUrl}`
            : imageUrl;

        log('log', `Fetching image from: ${fullUrl}`);

        const response = await fetch(fullUrl);
        if (!response.ok) {
            log('error', `Failed to fetch image: ${response.status} ${response.statusText}`);
            return null;
        }

        const blob = await response.blob();
        const mimeType = blob.type || 'image/png';

        return new Promise((resolve, reject) => {
            const reader = new FileReader();
            reader.onloadend = () => {
                // reader.result is "data:image/png;base64,xxxxx"
                // Extract just the base64 part
                const base64Data = reader.result.split(',')[1];
                resolve({ base64: base64Data, mimeType: mimeType });
            };
            reader.onerror = reject;
            reader.readAsDataURL(blob);
        });
    } catch (error) {
        log('error', `Error fetching image: ${error.message}`);
        return null;
    }
}

/**
 * @typedef {Object} UploadedFile
 * @property {string} url - URL path to the uploaded file
 * @property {string} type - 'image' | 'video' | 'audio' | 'file'
 * @property {string} fileName - Original file name
 * @property {string} mimeType - MIME type
 */

/**
 * Processes file attachments from Telegram and uploads them to SillyTavern
 * @param {Array<{base64: string, mimeType: string, fileName: string}>} files - Files from Telegram
 * @returns {Promise<UploadedFile[]>} Array of uploaded file info
 */
async function processFileAttachments(files) {
    const uploaded = [];

    log('log', `Processing ${files.length} file attachment(s) from Telegram`);

    for (const file of files) {
        try {
            log('log', `Uploading file: ${file.fileName} (${file.mimeType}), base64 length: ${file.base64.length}`);

            // Determine file type category
            const isImage = file.mimeType.startsWith('image/');
            const isVideo = file.mimeType.startsWith('video/');
            const isAudio = file.mimeType.startsWith('audio/');

            // Get file extension from filename or mime type
            let ext = file.fileName.includes('.')
                ? file.fileName.split('.').pop()
                : null;

            // Fallback extension from mime type
            if (!ext) {
                const mimeExtMap = {
                    'image/jpeg': 'jpg',
                    'image/png': 'png',
                    'image/gif': 'gif',
                    'image/webp': 'webp',
                    'video/mp4': 'mp4',
                    'video/webm': 'webm',
                    'audio/mpeg': 'mp3',
                    'audio/ogg': 'ogg',
                    'audio/wav': 'wav',
                };
                ext = mimeExtMap[file.mimeType] || 'bin';
            }

            log('log', `File type: ${isImage ? 'image' : isVideo ? 'video' : isAudio ? 'audio' : 'file'}, extension: ${ext}`);

            // Upload to SillyTavern server using saveBase64AsFile
            // Parameters: (base64Data, uniqueId, prefix, extension)
            // Use timestamp + random string to ensure unique filenames
            const uniqueId = `${Date.now()}_${Math.random().toString(36).substring(2, 8)}`;
            const url = await saveBase64AsFile(file.base64, uniqueId, 'telegram', ext);

            log('log', `File uploaded successfully: ${url}`);

            uploaded.push({
                url: url,
                type: isImage ? 'image' : isVideo ? 'video' : isAudio ? 'audio' : 'file',
                fileName: file.fileName,
                mimeType: file.mimeType,
            });
        } catch (error) {
            log('error', `Failed to upload file ${file.fileName}: ${error.message}`);
        }
    }

    log('log', `Successfully uploaded ${uploaded.length}/${files.length} files`);
    return uploaded;
}

/**
 * Builds the extra object for a user message with file attachments
 * @param {UploadedFile[]} uploadedFiles - Array of uploaded file info
 * @returns {Object} Extra object to merge into message
 */
function buildFileExtras(uploadedFiles) {
    const extras = {};

    // Separate files by type
    const images = uploadedFiles.filter(f => f.type === 'image');
    const videos = uploadedFiles.filter(f => f.type === 'video');
    const audios = uploadedFiles.filter(f => f.type === 'audio');
    const otherFiles = uploadedFiles.filter(f => f.type === 'file');

    log('log', `Building extras: ${images.length} images, ${videos.length} videos, ${audios.length} audio, ${otherFiles.length} other`);

    // Always use media array for images (ST rejects extra.image, requires extra.media)
    if (images.length > 0) {
        extras.media = images.map(img => ({
            url: img.url,
            type: 'image',
            title: '',
        }));
        log('log', `Set ${images.length} image(s) via media array`);
    }

    // Add videos to media array
    if (videos.length > 0) {
        const videoMedia = videos.map(v => ({
            url: v.url,
            type: 'video',
            title: '',
        }));
        extras.media = (extras.media || []).concat(videoMedia);
        log('log', `Added ${videos.length} video(s) to media array`);
    }

    // Add audio files to media array
    if (audios.length > 0) {
        const audioMedia = audios.map(a => ({
            url: a.url,
            type: 'audio',
            title: '',
        }));
        extras.media = (extras.media || []).concat(audioMedia);
        log('log', `Added ${audios.length} audio file(s) to media array`);
    }

    // For other files - ST uses extra.file for single file attachment
    if (otherFiles.length === 1) {
        extras.file = {
            url: otherFiles[0].url,
            name: otherFiles[0].fileName,
            size: 0, // We don't have the exact size, but ST may not require it
        };
        log('log', `Set single file attachment: ${otherFiles[0].fileName}`);
    } else if (otherFiles.length > 1) {
        // For multiple files, we might need a different approach
        // For now, only attach the first one and log a warning
        extras.file = {
            url: otherFiles[0].url,
            name: otherFiles[0].fileName,
            size: 0,
        };
        log('warn', `Multiple non-media files received, only attaching the first: ${otherFiles[0].fileName}`);
    }

    log('log', `Built extras object:`, JSON.stringify(extras, null, 2));
    return extras;
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
            // --- Character Switch (queued) ---
            case 'switchchar':
                if (data.args && data.args.length > 0) {
                    const targetName = data.args.join(' ');
                    result = await switchToCharacter(targetName, chatId, botId, isQueuedSwitch);
                } else {
                    result = {
                        success: false,
                        message: 'No character name provided.'
                    };
                }
                break;

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

            // --- Delete Messages ---
            case 'delete_messages':
                const count = data.args && data.args.length > 0 ? parseInt(data.args[0]) : 1;
                let deleted = 0;
                for (let i = 0; i < count; i++) {
                    // Safety check: don't delete if chat is empty
                    if (SillyTavern.getContext().chat.length === 0) break;
                    try {
                        await deleteLastMessage();
                        deleted++;
                    } catch (e) {
                        log('error', 'Failed to delete message:', e);
                        break;
                    }
                }
                result = {
                    success: true,
                    message: `Deleted ${deleted} message(s).`
                };
                break;

            // --- Trigger Generation ---
            case 'trigger_generation':
                if (activeRequest) {
                    result = {
                        success: false,
                        message: 'Generation already in progress.'
                    };
                } else {
                    // Run generation in background so we can return command success immediately
                    // We need to pass the current chat length so it knows where to start tracking context
                    const startIndex = SillyTavern.getContext().chat.length;
                    setupAndRunGeneration(chatId, botId, data.characterName, startIndex);

                    result = {
                        success: true,
                        message: 'Generation triggered.'
                    };
                }
                break;

            // --- Switch Model/Profile ---
            case 'switchmodel':
                if (!data.args || data.args.length === 0) {
                    result = {
                        success: false,
                        message: 'No model profile provided.'
                    };
                } else {
                    const profileName = data.args.join(' ');
                    try {
                        log('log', `Switching to profile via slash command: /profile ${profileName}`);
                        // Execute the slash command to switch profile
                        // We use the slash command because it handles all the UI/backend updates
                        await executeSlashCommands(`/profile ${profileName}`);
                        result = {
                            success: true,
                            message: `Switched to profile: ${profileName}`
                        };
                    } catch (err) {
                        log('error', `Failed to switch to profile "${profileName}":`, err);
                        result = {
                            success: false,
                            message: `Failed to switch to profile "${profileName}".`
                        };
                    }
                }
                break;

            // --- History Export ---
            // Note: This command sends history_file directly which handles job release,
            // so we return early to avoid sending command_executed
            case 'history':
                try {
                    await handleHistoryCommand(chatId, botId, data.characterName);
                    // Don't send command_executed - history_file message will release the job
                    return;
                } catch (err) {
                    log('error', 'Failed to generate history:', err);
                    result = {
                        success: false,
                        message: `Failed to generate history: ${err.message}`
                    };
                }
                break;

            // --- Summarize Conversation ---
            case 'summarize':
                try {
                    result = await handleSummarizeCommand(chatId, botId, data.characterName, data.summarizationConfig);
                } catch (err) {
                    log('error', 'Failed to generate summary:', err);
                    result = {
                        success: false,
                        message: `Failed to generate summary: ${err.message}`
                    };
                }
                break;

            // --- Set Summary (Save to Lorebook + New Chat) ---
            case 'set_summary':
                try {
                    const summaryText = data.args && data.args.length > 0 ? data.args[0] : '';
                    result = await handleSetSummaryCommand(chatId, botId, data.characterName, summaryText, data.summarizationConfig);
                } catch (err) {
                    log('error', 'Failed to save summary:', err);
                    result = {
                        success: false,
                        message: `Failed to save summary: ${err.message}`
                    };
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
 * Common logic to setup and run the generation process
 * Used by both handleUserMessage and trigger_generation command
 * @param {number} chatId - Telegram chat ID
 * @param {string} botId - Bot identifier
 * @param {string} characterName - Character being used
 * @param {number} startMessageIndex - Chat index when request started
 */
async function setupAndRunGeneration(chatId, botId, characterName, startMessageIndex) {
    // Set up active request tracking
    activeRequest = {
        chatId: chatId,
        botId: botId,
        characterName: characterName,
        isStreaming: false,
        startMessageIndex: startMessageIndex,
        collectedMedia: []
    };

    // Send typing indicator
    sendToServer({ type: 'typing_action', chatId, botId });

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

    // Define cleanup function for streaming
    const cleanupStreaming = () => {
        eventSource.removeListener(event_types.STREAM_TOKEN_RECEIVED, streamCallback);
    };

    // Trigger generation
    try {
        log('log', 'Starting Generate() call...');
        const abortController = new AbortController();
        setExternalAbortController(abortController);
        await Generate('normal', { signal: abortController.signal });
        log('log', 'Generate() call completed');

        // Clean up streaming listener
        cleanupStreaming();

        // Send stream_end if we were streaming
        if (activeRequest && activeRequest.isStreaming) {
            sendToServer({
                type: 'stream_end',
                chatId: activeRequest.chatId,
                botId: activeRequest.botId
            });
        }

        // Handle the final message now that generation is complete
        // We call this directly instead of relying on event listeners because
        // GENERATION_ENDED fires multiple times during tool calls
        if (activeRequest) {
            const context = SillyTavern.getContext();
            await handleFinalMessage(context.chat.length);
        }
    } catch (error) {
        log('error', 'Generate() error:', error);
        cleanupStreaming();

        // Delete all messages created since the request started
        // This includes: user message, any tool call messages, failed AI responses
        const currentContext = SillyTavern.getContext();
        const messagesToDelete = currentContext.chat.length - startMessageIndex;

        log('log', `Cleaning up ${messagesToDelete} messages (from index ${startMessageIndex} to ${currentContext.chat.length - 1})`);

        // Delete messages in reverse order (newest first)
        for (let i = 0; i < messagesToDelete; i++) {
            try {
                await deleteLastMessage();
                log('log', `Deleted message ${i + 1}/${messagesToDelete}`);
            } catch (deleteError) {
                log('error', `Failed to delete message: ${deleteError.message}`);
                break; // Stop if deletion fails
            }
        }

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

        activeRequest = null;
    }
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

    // Get current chat length to track new messages
    let context = SillyTavern.getContext();
    const startMessageIndex = context.chat.length;

    // Normalize input to an array of messages
    const messages = data.messages || [{ text: data.text, files: data.files }];
    log('log', `Processing batch of ${messages.length} message(s)`);

    for (const msg of messages) {
        log('log', `Processing message: text="${msg.text?.substring(0, 20)}...", files=${msg.files?.length || 0}`);

        // Process file attachments if present
        let fileExtras = null;
        if (msg.files && msg.files.length > 0) {
            log('log', `Processing ${msg.files.length} file attachment(s)...`);
            const uploadedFiles = await processFileAttachments(msg.files);
            if (uploadedFiles.length > 0) {
                fileExtras = buildFileExtras(uploadedFiles);
            }
        }

        // Add user message to SillyTavern
        await sendMessageAsUser(msg.text || '');

        // If we have file attachments, add them to the user message we just created
        if (fileExtras) {
            // Refresh context to get the updated chat
            context = SillyTavern.getContext();
            const userMessageIndex = context.chat.length - 1;
            const userMessage = context.chat[userMessageIndex];

            if (userMessage && userMessage.is_user) {
                log('log', `Attaching file extras to user message at index ${userMessageIndex}`);

                // Merge file extras into the message's extra object
                userMessage.extra = userMessage.extra || {};
                Object.assign(userMessage.extra, fileExtras);

                // Render the media in the UI
                try {
                    const messageElement = $(`#chat .mes[mesid="${userMessageIndex}"]`);
                    if (messageElement.length > 0) {
                        appendMediaToMessage(userMessage, messageElement, false);
                        log('log', `Media rendered in UI for message ${userMessageIndex}`);
                    } else {
                        log('warn', `Could not find message element for index ${userMessageIndex}`);
                    }
                } catch (renderError) {
                    log('error', `Failed to render media: ${renderError.message}`);
                }

                // Save the chat to persist the changes
                try {
                    const { saveChatConditional } = await import("../../../../script.js");
                    await saveChatConditional();
                    log('log', `Chat saved with file attachments`);
                } catch (saveError) {
                    log('error', `Failed to save chat: ${saveError.message}`);
                }
            } else {
                log('warn', `Could not find user message to attach files. Index: ${userMessageIndex}, is_user: ${userMessage?.is_user}`);
            }
        }
    }

    // Set up active request tracking and trigger generation
    await setupAndRunGeneration(chatId, botId, characterName, startMessageIndex);
}

// ============================================================================
// FINAL MESSAGE HANDLING
// ============================================================================

/**
 * Extracts rendered text content from a message DOM element
 * @param {number} messageIndex - Index of the message in the chat array
 * @returns {string} The extracted text content, or empty string if not found
 */
function extractMessageText(messageIndex) {
    const messageElement = $(`#chat .mes[mesid="${messageIndex}"]`);

    if (messageElement.length === 0) {
        return '';
    }

    const messageTextElement = messageElement.find('.mes_text');

    // Get HTML content and convert to plain text
    let renderedText = messageTextElement.html()
        .replace(/<br\s*\/?>/gi, '\n')
        .replace(/<\/p>\s*<p>/gi, '\n\n');

    // Decode HTML entities
    const tempDiv = document.createElement('div');
    tempDiv.innerHTML = renderedText;
    renderedText = tempDiv.textContent;

    return renderedText.trim();
}

/**
 * Handles the final message after generation completes
 * Extracts rendered text from the DOM and sends it to the server
 * Preserves the order of text and images as they appear in the chat
 * @param {number} lastMessageIdInChatArray - Index of the last message in the chat array
 */
async function handleFinalMessage(lastMessageIdInChatArray) {
    log('log', `handleFinalMessage called with index: ${lastMessageIdInChatArray}, activeRequest:`, activeRequest);

    // Ensure we have an active request to respond to
    if (!ws || ws.readyState !== WebSocket.OPEN || !activeRequest) {
        log('warn', `handleFinalMessage early return - ws: ${!!ws}, wsOpen: ${ws?.readyState === WebSocket.OPEN}, activeRequest: ${!!activeRequest}`);
        return;
    }

    // Capture the active request immediately and clear it to prevent duplicate handling
    // This is necessary because GENERATION_ENDED can fire multiple times (e.g., with tool calls)
    // and the await below would allow another handler to run concurrently
    const currentRequest = activeRequest;
    activeRequest = null;

    const lastMessageIndex = lastMessageIdInChatArray - 1;
    if (lastMessageIndex < 0) return;

    // Small delay to ensure DOM update is complete
    await new Promise(resolve => setTimeout(resolve, 100));

    const context = SillyTavern.getContext();
    const startIdx = currentRequest.startMessageIndex || 0;

    log('log', `Processing messages from index ${startIdx} to ${context.chat.length - 1} (chat length: ${context.chat.length})`);

    // Build an ordered array of content parts (text and images) as they appear in the chat
    // This preserves the original order: Message1 -> Image -> Message2
    const contentParts = [];

    for (let i = startIdx; i < context.chat.length; i++) {
        const msg = context.chat[i];

        // Skip user messages and system messages
        if (!msg || msg.is_user || msg.is_system) {
            log('log', `  Message ${i}: skipping (is_user=${msg?.is_user}, is_system=${msg?.is_system})`);
            continue;
        }

        log('log', `  Message ${i}: processing AI message`);

        // Check if this message has media attachments (images)
        const hasMedia = msg.extra?.media?.length > 0;

        // Extract text content from this message, but SKIP text for messages with media
        // Messages with images typically contain auto-generated descriptions like
        // "[Assistant shows an image of ...]" which shouldn't be sent to Telegram
        if (!hasMedia) {
            const textContent = extractMessageText(i);
            if (textContent) {
                contentParts.push({
                    type: 'text',
                    content: textContent,
                });
                log('log', `    Added text part (${textContent.length} chars)`);
            }
        } else {
            log('log', `    Skipping text extraction (message has media)`);
        }

        // Check for media attachments on this message
        if (hasMedia) {
            for (const media of msg.extra.media) {
                if (media.type === 'image' && media.url) {
                    log('log', `    Found image: ${media.url.substring(0, 50)}...`);
                    const imageData = await fetchImageAsBase64(media.url);
                    if (imageData) {
                        contentParts.push({
                            type: 'image',
                            base64: imageData.base64,
                            mimeType: imageData.mimeType,
                        });
                        log('log', `    Added image part (${imageData.mimeType}, ${imageData.base64.length} chars)`);
                    }
                }
            }
        }
    }

    if (contentParts.length === 0) {
        log('warn', 'No content parts found to send');
        return;
    }

    log('log', `Sending ${contentParts.length} content part(s) to bot ${currentRequest.botId}`);

    // Build the payload with ordered content parts
    const payload = {
        chatId: currentRequest.chatId,
        botId: currentRequest.botId,
        contentParts: contentParts,
    };

    // Send appropriate message type based on streaming state
    if (currentRequest.isStreaming) {
        sendToServer({
            type: 'final_message_update',
            ...payload,
        });
    } else {
        sendToServer({
            type: 'ai_reply',
            ...payload,
        });
    }
}

// NOTE: We do NOT register global listeners for GENERATION_ENDED/GENERATION_STOPPED here.
// These events fire for ALL generations in SillyTavern, including internal ones during tool calls.
// Instead, we register .once() handlers in setupAndRunGeneration() only for our own requests.

// Register event listener for image generation start
eventSource.on('sd_prompt_processing', () => {
    if (activeRequest) {
        log('log', 'Image generation started, sending chat action to server');
        sendToServer({
            type: 'chat_action',
            chatId: activeRequest.chatId,
            botId: activeRequest.botId,
            action: 'upload_photo'
        });
    }
});

// ============================================================================
// SUMMARIZATION & ARCHIVAL
// ============================================================================

/**
 * Default summarization prompt template
 * Used when no custom prompt is provided in config
 */
const DEFAULT_SUMMARIZATION_PROMPT = `You are a memory archivist. Your task is to create a concise summary of the conversation that just occurred between {{user}} and {{char}}.

Focus on:
- Key events and decisions made
- Important information revealed about characters
- Emotional moments or relationship developments
- Any promises, plans, or commitments made

Format the summary as a narrative paragraph, written in past tense from a third-person perspective. Keep it under 300 words.

Do not include meta-commentary about the conversation itself. Write as if documenting events that actually happened.`;

/**
 * Handles the /summarize command by generating a conversation summary
 * Uses "dry-run" generation that doesn't affect the main chat history
 * @param {number} chatId - Telegram chat ID
 * @param {string} botId - Bot identifier
 * @param {string} characterName - Character name
 * @param {Object} summarizationConfig - Config from server (optional)
 * @returns {Promise<{success: boolean, message: string}>}
 */
async function handleSummarizeCommand(chatId, botId, characterName, summarizationConfig) {
    const context = SillyTavern.getContext();
    
    // Check if there's a chat loaded
    if (!context.chat || context.chat.length === 0) {
        return {
            success: false,
            message: 'No conversation to summarize. Start chatting first!'
        };
    }

    // Get character and user names for prompt substitution
    const charName = characterName || context.name2 || 'Character';
    const userName = context.name1 || 'User';
    
    log('log', `Generating summary for ${charName}, ${context.chat.length} messages`);

    // Get summarization prompt from config or use default
    let prompt = summarizationConfig?.prompt || DEFAULT_SUMMARIZATION_PROMPT;
    
    // Replace template variables
    prompt = prompt
        .replace(/\{\{user\}\}/gi, userName)
        .replace(/\{\{char\}\}/gi, charName);

    try {
        // Generate summary using quiet generation (doesn't affect chat history)
        // This is a "dry-run" - the output is not added to the conversation
        const summary = await generateQuietPrompt(prompt, false, false);
        
        if (!summary || summary.trim().length === 0) {
            return {
                success: false,
                message: 'Failed to generate summary. The model returned an empty response.'
            };
        }

        log('log', `Summary generated successfully (${summary.length} chars)`);

        // Return the summary for the user to review
        // The message format includes instructions for the next step
        const responseMessage = `**Conversation Summary**\n\n${summary}\n\n---\n_Review and edit this summary as needed, then use /set_summary <text> to save it and start a new chat._`;

        return {
            success: true,
            message: responseMessage
        };
    } catch (err) {
        log('error', 'Summary generation failed:', err);
        return {
            success: false,
            message: `Summary generation failed: ${err.message}`
        };
    }
}

/**
 * Handles the /set_summary command by saving summary to lorebook and starting new chat
 * @param {number} chatId - Telegram chat ID
 * @param {string} botId - Bot identifier
 * @param {string} characterName - Character name
 * @param {string} summaryText - The summary text to save
 * @param {Object} summarizationConfig - Config from server (optional)
 * @returns {Promise<{success: boolean, message: string}>}
 */
async function handleSetSummaryCommand(chatId, botId, characterName, summaryText, summarizationConfig) {
    const context = SillyTavern.getContext();
    
    // Validate summary text
    if (!summaryText || summaryText.trim().length === 0) {
        return {
            success: false,
            message: 'Please provide summary text. Usage: /set_summary <your summary text>'
        };
    }

    // Get config values with defaults
    const lorebookName = summarizationConfig?.lorebookName || 'Character Memories';
    const entryName = summarizationConfig?.lorebookEntry || 'Past Events';
    const charName = characterName || context.name2 || 'Character';

    log('log', `Saving summary to lorebook "${lorebookName}", entry "${entryName}"`);

    try {
        // Step 1: Save to World Info / Lorebook
        await appendToWorldInfo(lorebookName, entryName, summaryText.trim(), charName);
        log('log', 'Summary saved to World Info successfully');

        // Step 2: Start new chat (archive current conversation)
        await doNewChat({ deleteCurrentChat: false });
        log('log', 'New chat started successfully');

        return {
            success: true,
            message: `Summary saved to "${lorebookName}" and new chat started.`
        };
    } catch (err) {
        log('error', 'Failed to save summary:', err);
        return {
            success: false,
            message: `Failed to save summary: ${err.message}`
        };
    }
}

/**
 * Appends content to a World Info entry, creating the book/entry if needed
 * @param {string} bookName - Name of the World Info book
 * @param {string} entryName - Name/comment of the entry
 * @param {string} content - Content to append
 * @param {string} characterName - Character name for new book creation
 */
async function appendToWorldInfo(bookName, entryName, content, characterName) {
    // Check if the lorebook exists
    if (!world_names.includes(bookName)) {
        throw new Error(`World Info book "${bookName}" not found. Please create it first in SillyTavern.`);
    }

    // Load the World Info book
    const data = await loadWorldInfo(bookName);
    if (!data || !data.entries) {
        throw new Error(`Failed to load World Info book "${bookName}"`);
    }

    // Find existing entry by comment/name
    let entry = Object.values(data.entries).find(
        e => e.comment === entryName
    );

    // Create new entry if it doesn't exist
    if (!entry) {
        log('log', `Entry "${entryName}" not found, creating new entry`);
        entry = createWorldInfoEntry(bookName, data);
        entry.comment = entryName;
        entry.key = [entryName.toLowerCase(), characterName.toLowerCase(), 'memories', 'past events'];
        entry.constant = true; // Always include in context
        entry.selective = false;
        entry.position = 0; // Before main prompt
        entry.order = 100;
        entry.content = '# Memories\n\n';
    }

    // Format the new content with timestamp
    const timestamp = new Date().toISOString().split('T')[0];
    const formattedContent = `[${timestamp}]\n${content}`;

    // Append content with separator
    if (entry.content && entry.content.trim().length > 0) {
        entry.content = `${entry.content}\n\n---\n\n${formattedContent}`;
    } else {
        entry.content = formattedContent;
    }

    // Save the World Info book
    await saveWorldInfo(bookName, data, true);
    log('log', `World Info entry "${entryName}" updated successfully`);
}

// ============================================================================
// HISTORY EXPORT
// ============================================================================

/**
 * Handles the /history command by generating and sending an HTML file
 * @param {number} chatId - Telegram chat ID
 * @param {string} botId - Bot identifier
 * @param {string} characterName - Character name for the filename
 */
async function handleHistoryCommand(chatId, botId, characterName) {
    const context = SillyTavern.getContext();
    
    // Fallback for character name
    const charName = characterName || context.name2 || 'Character';
    
    // Check if there's a chat loaded
    if (!context.chat || context.chat.length === 0) {
        throw new Error('No chat history available. Start a conversation first!');
    }

    log('log', `Generating chat history HTML for ${charName}, ${context.chat.length} messages`);

    // Generate HTML
    const html = generateHistoryHTML(context.chat, charName, context.name1 || 'You');
    
    // Convert to base64
    const base64Data = btoa(unescape(encodeURIComponent(html)));
    
    // Generate filename with date
    const now = new Date();
    const dateStr = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
    const fileName = `History_${charName}_${dateStr}.html`;
    
    log('log', `Sending history file: ${fileName}, size: ${base64Data.length} chars`);
    
    // Send to server
    sendToServer({
        type: 'history_file',
        chatId: chatId,
        botId: botId,
        fileData: base64Data,
        fileName: fileName
    });
}

/**
 * Generates HTML for chat history
 * @param {Array} chat - Chat messages array
 * @param {string} characterName - Character name
 * @param {string} userName - User name
 * @returns {string} HTML string
 */
function generateHistoryHTML(chat, characterName, userName) {
    const htmlParts = [];
    
    // HTML header with dark mode styling
    htmlParts.push(`<!DOCTYPE html>
<html>
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Chat History: ${escapeHtml(characterName)}</title>
<style>
  body { 
    background-color: #1e1e1e; 
    color: #eee; 
    font-family: sans-serif; 
    max-width: 800px; 
    margin: auto; 
    padding: 20px; 
  }
  .msg { 
    padding: 10px; 
    margin-bottom: 10px; 
    border-radius: 8px; 
  }
  .user { 
    background-color: #2b5278; 
    text-align: right; 
    margin-left: 20%; 
  }
  .char { 
    background-color: #2b2b2b; 
    text-align: left; 
    margin-right: 20%; 
  }
  .system {
    background-color: #3a3a3a;
    text-align: center;
    font-style: italic;
    color: #aaa;
  }
  .name { 
    font-weight: bold; 
    font-size: 0.9em; 
    margin-bottom: 5px; 
    color: #aaa; 
  }
  .content {
    white-space: pre-wrap;
    word-wrap: break-word;
  }
  .timestamp {
    font-size: 0.8em;
    color: #888;
    margin-top: 5px;
  }
  img {
    max-width: 100%;
    border-radius: 4px;
    margin-top: 8px;
  }
</style>
</head>
<body>
  <h2>Chat History: ${escapeHtml(characterName)}</h2>
  <p style="color: #888; font-size: 0.9em;">Exported on ${new Date().toLocaleString()}</p>
  <hr style="border-color: #444;">
`);

    // Process each message
    for (const msg of chat) {
        if (msg.is_system) {
            // System message
            htmlParts.push(`  <div class="msg system">
    <div class="content">${escapeHtml(msg.mes || '')}</div>
  </div>
`);
        } else if (msg.is_user) {
            // User message
            htmlParts.push(`  <div class="msg user">
    <div class="name">${escapeHtml(userName)}</div>
    <div class="content">${escapeHtml(msg.mes || '')}</div>
  </div>
`);
        } else {
            // Character message
            htmlParts.push(`  <div class="msg char">
    <div class="name">${escapeHtml(characterName)}</div>
    <div class="content">${escapeHtml(msg.mes || '')}</div>
  </div>
`);
        }
    }

    // HTML footer
    htmlParts.push(`</body>
</html>`);

    return htmlParts.join('');
}

/**
 * Escapes HTML special characters
 * @param {string} text - Text to escape
 * @returns {string} Escaped text
 */
function escapeHtml(text) {
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
}

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
