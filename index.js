/**
 * SillyTavern Telegram Connector Extension
 * 
 * Main entry point for the SillyTavern extension.
 * Handles communication between SillyTavern and the Telegram Bridge server.
 * Supports bot-per-character architecture with queued request processing.
 * 
 * @module index
 */

// ============================================================================
// SILLYTAVERN IMPORTS (must use relative paths from extension root)
// ============================================================================

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
} from "../../../../script.js";

import {
    saveBase64AsFile,
} from "../../../utils.js";

// ============================================================================
// LOCAL IMPORTS
// ============================================================================

import { Logger } from './src/utils/logger.js';
import { MODULE_NAME, DEFAULT_SETTINGS, EVENTS, COMMANDS, MIME_EXTENSION_MAP } from './src/constants/index.js';

// ============================================================================
// CONTEXT UTILITIES (from SillyTavern.getContext())
// ============================================================================

const {
    extensionSettings,
    deleteLastMessage,
    saveSettingsDebounced,
    executeSlashCommands,
} = SillyTavern.getContext();

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
 * @property {number} startMessageIndex - Chat index when request started
 * @property {Array} collectedMedia - Media collected during this request
 */

/** @type {ActiveRequest|null} */
let activeRequest = null;

// ============================================================================
// SETTINGS SERVICE
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

// ============================================================================
// UI UTILITIES
// ============================================================================

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

// ============================================================================
// MEDIA UTILITIES
// ============================================================================

/**
 * Fetches an image from a URL and converts it to base64
 * @param {string} imageUrl - The image URL (relative or absolute)
 * @returns {Promise<{base64: string, mimeType: string}|null>} Base64 data or null on error
 */
async function fetchImageAsBase64(imageUrl) {
    try {
        const fullUrl = imageUrl.startsWith('/') 
            ? `${window.location.origin}${imageUrl}` 
            : imageUrl;
        
        Logger.debug(`Fetching image from: ${fullUrl}`);
        
        const response = await fetch(fullUrl);
        if (!response.ok) {
            Logger.error(`Failed to fetch image: ${response.status} ${response.statusText}`);
            return null;
        }
        
        const blob = await response.blob();
        const mimeType = blob.type || 'image/png';
        
        return new Promise((resolve, reject) => {
            const reader = new FileReader();
            reader.onloadend = () => {
                const base64Data = reader.result.split(',')[1];
                resolve({ base64: base64Data, mimeType: mimeType });
            };
            reader.onerror = reject;
            reader.readAsDataURL(blob);
        });
    } catch (error) {
        Logger.error(`Error fetching image: ${error.message}`);
        return null;
    }
}

/**
 * Scans messages created during the current request for media
 * @param {number} startIndex - Index to start scanning from
 * @param {number} endIndex - Index to stop scanning at (exclusive)
 * @returns {Array} Array of media items found
 */
function scanMessagesForMedia(startIndex, endIndex) {
    const context = SillyTavern.getContext();
    const mediaItems = [];
    
    Logger.debug(`scanMessagesForMedia: checking messages ${startIndex} to ${endIndex - 1}`);
    
    for (let i = startIndex; i < endIndex; i++) {
        const msg = context.chat[i];
        
        if (msg?.is_user) {
            continue;
        }
        
        if (msg?.extra?.media?.length > 0) {
            for (const media of msg.extra.media) {
                if (media.type === 'image' && media.url) {
                    mediaItems.push({
                        type: media.type,
                        url: media.url,
                        title: media.title || ''
                    });
                }
            }
        }
    }
    
    return mediaItems;
}

/**
 * Processes file attachments from Telegram and uploads them to SillyTavern
 * @param {Array} files - Files from Telegram
 * @returns {Promise<Array>} Array of uploaded file info
 */
async function processFileAttachments(files) {
    const uploaded = [];
    
    Logger.info(`Processing ${files.length} file attachment(s) from Telegram`);
    
    for (const file of files) {
        try {
            const isImage = file.mimeType.startsWith('image/');
            const isVideo = file.mimeType.startsWith('video/');
            const isAudio = file.mimeType.startsWith('audio/');
            
            let ext = file.fileName.includes('.') 
                ? file.fileName.split('.').pop() 
                : null;
            
            if (!ext) {
                ext = MIME_EXTENSION_MAP[file.mimeType] || 'bin';
            }
            
            const uniqueId = `${Date.now()}_${Math.random().toString(36).substring(2, 8)}`;
            const url = await saveBase64AsFile(file.base64, uniqueId, 'telegram', ext);
            
            uploaded.push({
                url: url,
                type: isImage ? 'image' : isVideo ? 'video' : isAudio ? 'audio' : 'file',
                fileName: file.fileName,
                mimeType: file.mimeType,
            });
        } catch (error) {
            Logger.error(`Failed to upload file ${file.fileName}: ${error.message}`);
        }
    }
    
    return uploaded;
}

/**
 * Builds the extra object for a user message with file attachments
 * @param {Array} uploadedFiles - Array of uploaded file info
 * @returns {Object} Extra object to merge into message
 */
function buildFileExtras(uploadedFiles) {
    const extras = {};
    
    const images = uploadedFiles.filter(f => f.type === 'image');
    const videos = uploadedFiles.filter(f => f.type === 'video');
    const audios = uploadedFiles.filter(f => f.type === 'audio');
    const otherFiles = uploadedFiles.filter(f => f.type === 'file');
    
    if (images.length > 0) {
        extras.media = images.map(img => ({ url: img.url, type: 'image', title: '' }));
    }
    
    if (videos.length > 0) {
        const videoMedia = videos.map(v => ({ url: v.url, type: 'video', title: '' }));
        extras.media = (extras.media || []).concat(videoMedia);
    }
    
    if (audios.length > 0) {
        const audioMedia = audios.map(a => ({ url: a.url, type: 'audio', title: '' }));
        extras.media = (extras.media || []).concat(audioMedia);
    }
    
    if (otherFiles.length >= 1) {
        extras.file = {
            url: otherFiles[0].url,
            name: otherFiles[0].fileName,
            size: 0,
        };
    }
    
    return extras;
}

// ============================================================================
// CHARACTER SERVICE
// ============================================================================

/**
 * Finds a character by name and returns its index
 * @param {string} characterName - Name of the character to find
 * @returns {{found: boolean, index: number, message: string}} Result object
 */
function findCharacterByName(characterName) {
    const context = SillyTavern.getContext();
    const characters = context.characters;

    const targetChar = characters.find(c => c.name === characterName);
    if (targetChar) {
        return { found: true, index: characters.indexOf(targetChar), message: 'Found' };
    }

    const targetCharCI = characters.find(c => c.name.toLowerCase() === characterName.toLowerCase());
    if (targetCharCI) {
        return { found: true, index: characters.indexOf(targetCharCI), message: 'Found (case-insensitive)' };
    }

    return { found: false, index: -1, message: `Character "${characterName}" not found.` };
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
 * Switches to a character by name
 * @param {string} characterName - Name of the character to switch to
 * @returns {Promise<{success: boolean, message: string}>}
 */
async function switchToCharacter(characterName) {
    if (isCurrentCharacter(characterName)) {
        return { success: true, message: `Already chatting with ${characterName}.` };
    }

    const searchResult = findCharacterByName(characterName);
    if (!searchResult.found) {
        return { success: false, message: searchResult.message };
    }

    try {
        await selectCharacterById(searchResult.index);
        return { success: true, message: `Switched to ${characterName}.` };
    } catch (error) {
        Logger.error(`Failed to switch to character "${characterName}":`, error);
        return { success: false, message: `Failed to switch to ${characterName}: ${error.message}` };
    }
}

// ============================================================================
// WEBSOCKET SERVICE
// ============================================================================

/**
 * Establishes a WebSocket connection to the bridge server
 */
function connect() {
    if (ws && ws.readyState === WebSocket.OPEN) {
        Logger.info('Already connected');
        return;
    }

    const settings = getSettings();
    if (!settings.bridgeUrl) {
        updateStatus('URL not set!', 'red');
        return;
    }

    updateStatus('Connecting...', 'orange');
    Logger.info(`Connecting to ${settings.bridgeUrl}...`);

    ws = new WebSocket(settings.bridgeUrl);

    ws.onopen = () => {
        Logger.info('Connection successful!');
        updateStatus('Connected', 'green');
    };

    ws.onmessage = handleWebSocketMessage;

    ws.onclose = () => {
        Logger.info('Connection closed.');
        updateStatus('Disconnected', 'red');
        ws = null;
        activeRequest = null;
    };

    ws.onerror = (error) => {
        Logger.error('WebSocket error:', error);
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
        Logger.warn('Cannot send message: WebSocket not connected');
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

        if (data.type === EVENTS.EXECUTE_COMMAND) {
            await handleExecuteCommand(data);
            return;
        }

        if (data.type === EVENTS.USER_MESSAGE) {
            await handleUserMessage(data);
            return;
        }

    } catch (error) {
        Logger.error('Error processing message:', error);
        if (data && data.chatId && data.botId) {
            sendToServer({
                type: EVENTS.ERROR_MESSAGE,
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
    Logger.info(`Executing command: ${data.command}`, data);

    const { chatId, botId, command, args, characterName } = data;
    const isQueuedSwitch = data.isQueuedSwitch || false;

    sendToServer({ type: EVENTS.TYPING_ACTION, chatId, botId });

    const context = SillyTavern.getContext();
    let result = { success: false, message: 'Unknown command' };

    try {
        switch (command) {
            case COMMANDS.SWITCH_CHAR:
                if (args && args.length > 0) {
                    result = await switchToCharacter(args.join(' '));
                } else {
                    result = { success: false, message: 'No character name provided.' };
                }
                break;

            case COMMANDS.NEW_CHAT:
                await doNewChat({ deleteCurrentChat: false });
                result = { success: true, message: 'New chat has been started.' };
                break;

            case COMMANDS.LIST_CHATS:
                if (context.characterId === undefined) {
                    result = { success: false, message: 'No character selected.' };
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
                        result = { success: true, message: 'No chat logs found for this character.' };
                    }
                }
                break;

            case COMMANDS.SWITCH_CHAT:
                if (!args || args.length === 0) {
                    result = { success: false, message: 'Please provide a chat log name.' };
                } else {
                    try {
                        await openCharacterChat(args.join(' '));
                        result = { success: true, message: `Loaded chat log: ${args.join(' ')}` };
                    } catch (err) {
                        result = { success: false, message: `Failed to load chat log.` };
                    }
                }
                break;

            case COMMANDS.DELETE_MESSAGES:
                const count = args && args.length > 0 ? parseInt(args[0]) : 1;
                let deleted = 0;
                for (let i = 0; i < count; i++) {
                    if (SillyTavern.getContext().chat.length === 0) break;
                    try {
                        await deleteLastMessage();
                        deleted++;
                    } catch (e) {
                        break;
                    }
                }
                result = { success: true, message: `Deleted ${deleted} message(s).` };
                break;

            case COMMANDS.TRIGGER_GENERATION:
                if (activeRequest) {
                    result = { success: false, message: 'Generation already in progress.' };
                } else {
                    const startIndex = SillyTavern.getContext().chat.length;
                    setupAndRunGeneration(chatId, botId, characterName, startIndex);
                    result = { success: true, message: 'Generation triggered.' };
                }
                break;

            case COMMANDS.SWITCH_MODEL:
                if (!args || args.length === 0) {
                    result = { success: false, message: 'No model profile provided.' };
                } else {
                    try {
                        await executeSlashCommands(`/profile ${args.join(' ')}`);
                        result = { success: true, message: `Switched to profile: ${args.join(' ')}` };
                    } catch (err) {
                        result = { success: false, message: `Failed to switch profile.` };
                    }
                }
                break;

            default:
                // Handle numbered commands (switchchat_N)
                const chatMatch = command.match(/^switchchat_(\d+)$/);
                if (chatMatch && context.characterId !== undefined) {
                    const index = parseInt(chatMatch[1]) - 1;
                    const chatFiles = await getPastCharacterChats(context.characterId);
                    if (index >= 0 && index < chatFiles.length) {
                        const chatName = chatFiles[index].file_name.replace('.jsonl', '');
                        try {
                            await openCharacterChat(chatName);
                            result = { success: true, message: `Loaded chat log: ${chatName}` };
                        } catch (err) {
                            result = { success: false, message: 'Failed to load chat log.' };
                        }
                    } else {
                        result = { success: false, message: `Invalid chat number. Use /listchats to see available chats.` };
                    }
                } else {
                    result = { success: false, message: `Unknown command: ${command}` };
                }
        }
    } catch (error) {
        Logger.error('Command execution error:', error);
        result = { success: false, message: `Error executing command: ${error.message}` };
    }

    sendToServer({
        type: EVENTS.COMMAND_EXECUTED,
        command,
        success: result.success,
        message: result.message,
        chatId,
        botId,
        characterName: characterName || args?.[0],
        isQueuedSwitch
    });
}

/**
 * Handles user message generation requests
 * @param {Object} data - Message data from server
 */
async function handleUserMessage(data) {
    Logger.info('Received user message for generation', data);

    const { chatId, botId, characterName } = data;

    let context = SillyTavern.getContext();
    const startMessageIndex = context.chat.length;

    const messages = data.messages || [{ text: data.text, files: data.files }];

    for (const msg of messages) {
        let fileExtras = null;
        if (msg.files && msg.files.length > 0) {
            const uploadedFiles = await processFileAttachments(msg.files);
            if (uploadedFiles.length > 0) {
                fileExtras = buildFileExtras(uploadedFiles);
            }
        }

        await sendMessageAsUser(msg.text || '');

        if (fileExtras) {
            context = SillyTavern.getContext();
            const userMessageIndex = context.chat.length - 1;
            const userMessage = context.chat[userMessageIndex];

            if (userMessage && userMessage.is_user) {
                userMessage.extra = userMessage.extra || {};
                Object.assign(userMessage.extra, fileExtras);

                try {
                    const messageElement = $(`#chat .mes[mesid="${userMessageIndex}"]`);
                    if (messageElement.length > 0) {
                        appendMediaToMessage(userMessage, messageElement, false);
                    }
                } catch (renderError) {
                    Logger.error(`Failed to render media: ${renderError.message}`);
                }

                try {
                    const { saveChatConditional } = await import("../../../../script.js");
                    await saveChatConditional();
                } catch (saveError) {
                    Logger.error(`Failed to save chat: ${saveError.message}`);
                }
            }
        }
    }

    await setupAndRunGeneration(chatId, botId, characterName, startMessageIndex);
}

/**
 * Common logic to setup and run the generation process
 * @param {number} chatId - Telegram chat ID
 * @param {string} botId - Bot identifier
 * @param {string} characterName - Character being used
 * @param {number} startMessageIndex - Chat index when request started
 */
async function setupAndRunGeneration(chatId, botId, characterName, startMessageIndex) {
    activeRequest = {
        chatId,
        botId,
        characterName,
        isStreaming: false,
        startMessageIndex,
        collectedMedia: []
    };

    sendToServer({ type: EVENTS.TYPING_ACTION, chatId, botId });

    const streamCallback = (cumulativeText) => {
        if (activeRequest) {
            activeRequest.isStreaming = true;
            sendToServer({
                type: EVENTS.STREAM_CHUNK,
                chatId: activeRequest.chatId,
                botId: activeRequest.botId,
                text: cumulativeText,
            });
        }
    };
    eventSource.on(event_types.STREAM_TOKEN_RECEIVED, streamCallback);

    let errorOccurred = false;
    const cleanup = () => {
        eventSource.removeListener(event_types.STREAM_TOKEN_RECEIVED, streamCallback);
        if (activeRequest && activeRequest.isStreaming && !errorOccurred) {
            sendToServer({
                type: EVENTS.STREAM_END,
                chatId: activeRequest.chatId,
                botId: activeRequest.botId
            });
        }
    };

    eventSource.once(event_types.GENERATION_ENDED, cleanup);
    eventSource.once(event_types.GENERATION_STOPPED, cleanup);

    try {
        Logger.info('Starting Generate() call...');
        const abortController = new AbortController();
        setExternalAbortController(abortController);
        await Generate('normal', { signal: abortController.signal });
        Logger.info('Generate() call completed');
    } catch (error) {
        Logger.error('Generate() error:', error);
        errorOccurred = true;

        const currentContext = SillyTavern.getContext();
        const messagesToDelete = currentContext.chat.length - startMessageIndex;

        for (let i = 0; i < messagesToDelete; i++) {
            try {
                await deleteLastMessage();
            } catch (deleteError) {
                break;
            }
        }

        const errorMessage = `Sorry, an error occurred while generating a reply.\nYour previous message has been retracted, please retry or send different content.\n\nError details: ${error.message || 'Unknown error'}`;

        if (activeRequest) {
            sendToServer({
                type: EVENTS.ERROR_MESSAGE,
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
 * @param {number} lastMessageIdInChatArray - Index of the last message in the chat array
 */
async function handleFinalMessage(lastMessageIdInChatArray) {
    if (!ws || ws.readyState !== WebSocket.OPEN || !activeRequest) {
        return;
    }

    const lastMessageIndex = lastMessageIdInChatArray - 1;
    if (lastMessageIndex < 0) return;

    await new Promise(resolve => setTimeout(resolve, 100));

    const context = SillyTavern.getContext();
    const lastMessage = context.chat[lastMessageIndex];

    const startIdx = activeRequest.startMessageIndex || 0;
    const mediaItems = scanMessagesForMedia(startIdx, context.chat.length);

    if (lastMessage && !lastMessage.is_user && !lastMessage.is_system) {
        const messageElement = $(`#chat .mes[mesid="${lastMessageIndex}"]`);

        if (messageElement.length > 0) {
            const messageTextElement = messageElement.find('.mes_text');

            let renderedText = messageTextElement.html()
                .replace(/<br\s*\/?>/gi, '\n')
                .replace(/<\/p>\s*<p>/gi, '\n\n');

            const tempDiv = document.createElement('div');
            tempDiv.innerHTML = renderedText;
            renderedText = tempDiv.textContent;

            const images = [];
            for (const media of mediaItems) {
                if (media.type === 'image') {
                    const imageData = await fetchImageAsBase64(media.url);
                    if (imageData) {
                        images.push({
                            base64: imageData.base64,
                            mimeType: imageData.mimeType,
                        });
                    }
                }
            }

            const payload = {
                chatId: activeRequest.chatId,
                botId: activeRequest.botId,
                text: renderedText,
                images: images.length > 0 ? images : undefined,
            };

            if (activeRequest.isStreaming) {
                sendToServer({ type: EVENTS.FINAL_MESSAGE_UPDATE, ...payload });
            } else {
                sendToServer({ type: EVENTS.AI_REPLY, ...payload });
            }

            activeRequest = null;
        }
    }
}

// ============================================================================
// GLOBAL EVENT LISTENERS (registered at module load time)
// ============================================================================

eventSource.on(event_types.GENERATION_ENDED, handleFinalMessage);
eventSource.on(event_types.GENERATION_STOPPED, handleFinalMessage);

eventSource.on('sd_prompt_processing', () => {
    if (activeRequest) {
        Logger.info('Image generation started, sending chat action to server');
        sendToServer({
            type: EVENTS.CHAT_ACTION,
            chatId: activeRequest.chatId,
            botId: activeRequest.botId,
            action: 'upload_photo'
        });
    }
});

// ============================================================================
// EXTENSION INITIALIZATION
// ============================================================================

jQuery(async () => {
    Logger.info('Loading settings UI...');
    
    try {
        const settingsHtml = await $.get(`/scripts/extensions/third-party/${MODULE_NAME}/settings.html`);
        $('#extensions_settings').append(settingsHtml);
        Logger.info('Settings UI loaded.');

        const settings = getSettings();
        $('#telegram_bridge_url').val(settings.bridgeUrl);
        $('#telegram_auto_connect').prop('checked', settings.autoConnect);

        $('#telegram_bridge_url').on('input', () => {
            const settings = getSettings();
            settings.bridgeUrl = $('#telegram_bridge_url').val();
            saveSettingsDebounced();
        });

        $('#telegram_auto_connect').on('change', function() {
            const settings = getSettings();
            settings.autoConnect = $(this).prop('checked');
            Logger.info(`Auto-connect setting changed to: ${settings.autoConnect}`);
            saveSettingsDebounced();
        });

        $('#telegram_connect_button').on('click', connect);
        $('#telegram_disconnect_button').on('click', disconnect);

        if (settings.autoConnect) {
            Logger.info('Auto-connect enabled, connecting...');
            connect();
        }

    } catch (error) {
        Logger.error('Failed to load settings HTML:', error);
    }
    
    Logger.info('Extension loaded.');
});
