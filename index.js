/**
 * @fileoverview SillyTavern Telegram Connector Extension.
 * Handles communication between SillyTavern and the Telegram Bridge server.
 * Supports bot-per-character architecture with queued request processing.
 * @module index
 */

/* global jQuery, $ */

import SillyTavernAdapter from './src/extension/adapters/sillyTavernAdapter.js';
import BridgeClient, { BRIDGE_EVENTS } from './src/extension/components/bridgeClient.js';
import SettingsManager from './src/extension/components/settingsManager.js';

// =============================================================================
// Constants
// =============================================================================

const MODULE_NAME = 'SillyTavern-Telegram-Connector';

// =============================================================================
// Component Instances
// =============================================================================

/** @type {SillyTavernAdapter} */
let adapter = null;

/** @type {BridgeClient} */
let bridgeClient = null;

/** @type {SettingsManager} */
let settingsManager = null;

// =============================================================================
// State
// =============================================================================

/**
 * @typedef {Object} ActiveRequest
 * @property {number} chatId - Telegram chat ID.
 * @property {string} botId - Bot identifier.
 * @property {string} characterName - Character name.
 * @property {boolean} isStreaming - Whether streaming is active.
 * @property {number} startMessageIndex - Starting message index.
 * @property {Array} collectedMedia - Collected media items.
 */

/** @type {ActiveRequest|null} */
let activeRequest = null;

// =============================================================================
// Logging
// =============================================================================

/**
 * Logs a message with prefix.
 * @param {'log'|'error'|'warn'} level - Log level.
 * @param {...*} arguments_ - Arguments to log.
 */
function log(level, ...arguments_) {
    const prefix = '[Telegram Bridge]';
    switch (level) {
        case 'error':
            console.error(prefix, ...arguments_);
            break;
        case 'warn':
            console.warn(prefix, ...arguments_);
            break;
        default:
            console.log(prefix, ...arguments_);
    }
}

// =============================================================================
// UI Updates
// =============================================================================

/**
 * Updates the connection status display.
 * @param {string} message - Status message.
 * @param {string} color - CSS color.
 */
function updateStatus(message, color) {
    const statusElement = document.getElementById('telegram_connection_status');
    if (statusElement) {
        statusElement.textContent = `Status: ${message}`;
        statusElement.style.color = color;
    }
}

// =============================================================================
// Image & File Handling
// =============================================================================

/**
 * Fetches an image and converts to base64.
 * @param {string} imageUrl - Image URL.
 * @returns {Promise<{base64: string, mimeType: string}|null>}
 */
async function fetchImageAsBase64(imageUrl) {
    try {
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
 * Scans messages for media items.
 * @param {number} startIndex - Start index.
 * @param {number} endIndex - End index (exclusive).
 * @returns {Array} Media items found.
 */
function scanMessagesForMedia(startIndex, endIndex) {
    const chat = adapter.getChat();
    const mediaItems = [];

    log('log', `scanMessagesForMedia: checking messages ${startIndex} to ${endIndex - 1}`);

    for (let index = startIndex; index < endIndex; index++) {
        const message = chat[index];

        if (message?.is_user) {
            continue;
        }

        const hasMedia = message?.extra?.media?.length > 0;
        if (hasMedia) {
            for (const media of message.extra.media) {
                if (media.type === 'image' && media.url) {
                    mediaItems.push({
                        type: media.type,
                        url: media.url,
                        title: media.title || '',
                    });
                }
            }
        }
    }

    log('log', `scanMessagesForMedia: returning ${mediaItems.length} items`);
    return mediaItems;
}

/**
 * Processes file attachments from Telegram.
 * @param {Array} files - Files to process.
 * @returns {Promise<Array>} Uploaded files.
 */
async function processFileAttachments(files) {
    const uploaded = [];
    log('log', `Processing ${files.length} file attachment(s) from Telegram`);

    for (const file of files) {
        try {
            const isImage = file.mimeType.startsWith('image/');
            const isVideo = file.mimeType.startsWith('video/');
            const isAudio = file.mimeType.startsWith('audio/');

            let extension = file.fileName.includes('.')
                ? file.fileName.split('.').pop()
                : null;

            if (!extension) {
                const mimeExtensionMap = {
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
                extension = mimeExtensionMap[file.mimeType] || 'bin';
            }

            const uniqueId = `${Date.now()}_${Math.random().toString(36).substring(2, 8)}`;
            const url = await adapter.saveFile(file.base64, uniqueId, 'telegram', extension);

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

    return uploaded;
}

/**
 * Builds extras object for file attachments.
 * @param {Array} uploadedFiles - Uploaded files.
 * @returns {Object} Extras object.
 */
function buildFileExtras(uploadedFiles) {
    const extras = {};

    const images = uploadedFiles.filter((file) => file.type === 'image');
    const videos = uploadedFiles.filter((file) => file.type === 'video');
    const audios = uploadedFiles.filter((file) => file.type === 'audio');
    const otherFiles = uploadedFiles.filter((file) => file.type === 'file');

    if (images.length > 0) {
        extras.media = images.map((image) => ({
            url: image.url,
            type: 'image',
            title: '',
        }));
    }

    if (videos.length > 0) {
        const videoMedia = videos.map((video) => ({
            url: video.url,
            type: 'video',
            title: '',
        }));
        extras.media = (extras.media || []).concat(videoMedia);
    }

    if (audios.length > 0) {
        const audioMedia = audios.map((audio) => ({
            url: audio.url,
            type: 'audio',
            title: '',
        }));
        extras.media = (extras.media || []).concat(audioMedia);
    }

    if (otherFiles.length >= 1) {
        extras.file = {
            url: otherFiles[0].url,
            name: otherFiles[0].fileName,
            size: 0,
        };
        if (otherFiles.length > 1) {
            log('warn', 'Multiple non-media files received, only attaching the first');
        }
    }

    return extras;
}

// =============================================================================
// Character Switching
// =============================================================================

/**
 * Switches to a character.
 * @param {string} characterName - Character name.
 * @param {number} chatId - Telegram chat ID.
 * @param {string} botId - Bot identifier.
 * @param {boolean} isQueuedSwitch - Whether this is a queued switch.
 * @returns {Promise<{success: boolean, message: string}>}
 */
async function switchToCharacter(characterName, chatId, botId, isQueuedSwitch) {
    if (adapter.isCurrentCharacter(characterName)) {
        log('log', `Already on character "${characterName}", no switch needed`);
        return {
            success: true,
            message: `Already chatting with ${characterName}.`,
        };
    }

    const searchResult = adapter.findCharacterByName(characterName);
    if (!searchResult.found) {
        log('error', searchResult.message);
        return {
            success: false,
            message: searchResult.message,
        };
    }

    try {
        log('log', `Switching to character "${characterName}" (index: ${searchResult.index})`);
        await adapter.selectCharacter(searchResult.index);
        log('log', `Successfully switched to character "${characterName}"`);
        return {
            success: true,
            message: `Switched to ${characterName}.`,
        };
    } catch (error) {
        log('error', `Failed to switch to character "${characterName}":`, error);
        return {
            success: false,
            message: `Failed to switch to ${characterName}: ${error.message}`,
        };
    }
}

// =============================================================================
// Command Handling
// =============================================================================

/**
 * Handles execute_command messages.
 * @param {Object} data - Command data.
 */
async function handleExecuteCommand(data) {
    log('log', `Executing command: ${data.command}`, data);

    const chatId = data.chatId;
    const botId = data.botId;
    const isQueuedSwitch = data.isQueuedSwitch || false;

    bridgeClient.sendTypingAction(chatId, botId);

    let result = { success: false, message: 'Unknown command' };

    try {
        switch (data.command) {
            case 'switchchar':
                if (data.args && data.args.length > 0) {
                    const targetName = data.args.join(' ');
                    result = await switchToCharacter(targetName, chatId, botId, isQueuedSwitch);
                } else {
                    result = { success: false, message: 'No character name provided.' };
                }
                break;

            case 'new':
                await adapter.startNewChat(false);
                result = { success: true, message: 'New chat has been started.' };
                break;

            case 'listchats':
                result = await handleListChats();
                break;

            case 'switchchat':
                result = await handleSwitchChat(data.args);
                break;

            case 'delete_messages':
                result = await handleDeleteMessages(data.args);
                break;

            case 'trigger_generation':
                result = await handleTriggerGeneration(chatId, botId, data.characterName);
                break;

            case 'switchmodel':
                result = await handleSwitchModel(data.args);
                break;

            default:
                const chatMatch = data.command.match(/^switchchat_(\d+)$/);
                if (chatMatch) {
                    result = await handleSwitchChatByNumber(parseInt(chatMatch[1]));
                } else {
                    result = { success: false, message: `Unknown command: ${data.command}` };
                }
        }
    } catch (error) {
        log('error', 'Command execution error:', error);
        result = { success: false, message: `Error executing command: ${error.message}` };
    }

    bridgeClient.sendCommandExecuted({
        command: data.command,
        success: result.success,
        message: result.message,
        chatId: chatId,
        botId: botId,
        characterName: data.characterName || data.args?.[0],
        isQueuedSwitch: isQueuedSwitch,
    });
}

/**
 * Handles listchats command.
 * @returns {Promise<{success: boolean, message: string}>}
 */
async function handleListChats() {
    const characterId = adapter.getCurrentCharacterId();
    if (characterId === undefined) {
        return { success: false, message: 'No character selected.' };
    }

    const chatFiles = await adapter.getPastChats(characterId);
    if (chatFiles.length > 0) {
        let replyText = 'Chat logs for current character:\n\n';
        chatFiles.forEach((chat, index) => {
            const chatName = chat.file_name.replace('.jsonl', '');
            replyText += `${index + 1}. /switchchat_${index + 1} - ${chatName}\n`;
        });
        replyText += '\nUse /switchchat_<number> or /switchchat <name> to switch chats';
        return { success: true, message: replyText };
    }
    return { success: true, message: 'No chat logs found for this character.' };
}

/**
 * Handles switchchat command.
 * @param {Array} arguments_ - Command arguments.
 * @returns {Promise<{success: boolean, message: string}>}
 */
async function handleSwitchChat(arguments_) {
    if (!arguments_ || arguments_.length === 0) {
        return { success: false, message: 'Please provide a chat log name.' };
    }

    const targetChatFile = arguments_.join(' ');
    try {
        await adapter.openChat(targetChatFile);
        return { success: true, message: `Loaded chat log: ${targetChatFile}` };
    } catch (error) {
        log('error', 'Failed to load chat:', error);
        return { success: false, message: `Failed to load chat log "${targetChatFile}".` };
    }
}

/**
 * Handles switchchat by number.
 * @param {number} number - Chat number (1-based).
 * @returns {Promise<{success: boolean, message: string}>}
 */
async function handleSwitchChatByNumber(number) {
    const characterId = adapter.getCurrentCharacterId();
    if (characterId === undefined) {
        return { success: false, message: 'No character selected.' };
    }

    const index = number - 1;
    const chatFiles = await adapter.getPastChats(characterId);

    if (index >= 0 && index < chatFiles.length) {
        const targetChat = chatFiles[index];
        const chatName = targetChat.file_name.replace('.jsonl', '');
        try {
            await adapter.openChat(chatName);
            return { success: true, message: `Loaded chat log: ${chatName}` };
        } catch (error) {
            log('error', 'Failed to load chat:', error);
            return { success: false, message: 'Failed to load chat log.' };
        }
    }

    return {
        success: false,
        message: `Invalid chat log number: ${number}. Use /listchats to see available chats.`,
    };
}

/**
 * Handles delete_messages command.
 * @param {Array} arguments_ - Command arguments.
 * @returns {Promise<{success: boolean, message: string}>}
 */
async function handleDeleteMessages(arguments_) {
    const count = arguments_ && arguments_.length > 0 ? parseInt(arguments_[0]) : 1;
    let deleted = 0;

    for (let index = 0; index < count; index++) {
        if (adapter.getChatLength() === 0) {
            break;
        }
        try {
            await adapter.deleteLastMessage();
            deleted++;
        } catch (error) {
            log('error', 'Failed to delete message:', error);
            break;
        }
    }

    return { success: true, message: `Deleted ${deleted} message(s).` };
}

/**
 * Handles trigger_generation command.
 * @param {number} chatId - Telegram chat ID.
 * @param {string} botId - Bot identifier.
 * @param {string} characterName - Character name.
 * @returns {Promise<{success: boolean, message: string}>}
 */
async function handleTriggerGeneration(chatId, botId, characterName) {
    if (activeRequest) {
        return { success: false, message: 'Generation already in progress.' };
    }

    const startIndex = adapter.getChatLength();
    setupAndRunGeneration(chatId, botId, characterName, startIndex);

    return { success: true, message: 'Generation triggered.' };
}

/**
 * Handles switchmodel command.
 * @param {Array} arguments_ - Command arguments.
 * @returns {Promise<{success: boolean, message: string}>}
 */
async function handleSwitchModel(arguments_) {
    if (!arguments_ || arguments_.length === 0) {
        return { success: false, message: 'No model profile provided.' };
    }

    const profileName = arguments_.join(' ');
    try {
        log('log', `Switching to profile via slash command: /profile ${profileName}`);
        await adapter.executeSlashCommand(`/profile ${profileName}`);
        return { success: true, message: `Switched to profile: ${profileName}` };
    } catch (error) {
        log('error', `Failed to switch to profile "${profileName}":`, error);
        return { success: false, message: `Failed to switch to profile "${profileName}".` };
    }
}

// =============================================================================
// Generation Handling
// =============================================================================

/**
 * Sets up and runs AI generation.
 * @param {number} chatId - Telegram chat ID.
 * @param {string} botId - Bot identifier.
 * @param {string} characterName - Character name.
 * @param {number} startMessageIndex - Starting message index.
 */
async function setupAndRunGeneration(chatId, botId, characterName, startMessageIndex) {
    activeRequest = {
        chatId: chatId,
        botId: botId,
        characterName: characterName,
        isStreaming: false,
        startMessageIndex: startMessageIndex,
        collectedMedia: [],
    };

    bridgeClient.sendTypingAction(chatId, botId);

    const eventTypes = adapter.getEventTypes();
    let errorOccurred = false;

    const streamCallback = (cumulativeText) => {
        if (activeRequest) {
            activeRequest.isStreaming = true;
            bridgeClient.sendStreamChunk(activeRequest.chatId, activeRequest.botId, cumulativeText);
        }
    };
    adapter.addEventListener(eventTypes.STREAM_TOKEN_RECEIVED, streamCallback);

    const cleanup = () => {
        adapter.removeEventListener(eventTypes.STREAM_TOKEN_RECEIVED, streamCallback);
        if (activeRequest && activeRequest.isStreaming && !errorOccurred) {
            bridgeClient.sendStreamEnd(activeRequest.chatId, activeRequest.botId);
        }
    };

    adapter.addEventListenerOnce(eventTypes.GENERATION_ENDED, cleanup);
    adapter.addEventListenerOnce(eventTypes.GENERATION_STOPPED, cleanup);

    try {
        log('log', 'Starting Generate() call...');
        await adapter.generate();
        log('log', 'Generate() call completed');
    } catch (error) {
        log('error', 'Generate() error:', error);
        errorOccurred = true;

        const messagesToDelete = adapter.getChatLength() - startMessageIndex;
        log('log', `Cleaning up ${messagesToDelete} messages`);

        for (let index = 0; index < messagesToDelete; index++) {
            try {
                await adapter.deleteLastMessage();
            } catch (deleteError) {
                log('error', `Failed to delete message: ${deleteError.message}`);
                break;
            }
        }

        const errorMessage = `Sorry, an error occurred while generating a reply.\nYour previous message has been retracted, please retry or send different content.\n\nError details: ${error.message || 'Unknown error'}`;

        if (activeRequest) {
            bridgeClient.sendErrorMessage(activeRequest.chatId, activeRequest.botId, errorMessage);
        }

        cleanup();
        activeRequest = null;
    }
}

/**
 * Handles user_message messages.
 * @param {Object} data - Message data.
 */
async function handleUserMessage(data) {
    log('log', 'Received user message for generation', data);

    const chatId = data.chatId;
    const botId = data.botId;
    const characterName = data.characterName;

    const startMessageIndex = adapter.getChatLength();
    const messages = data.messages || [{ text: data.text, files: data.files }];

    log('log', `Processing batch of ${messages.length} message(s)`);

    for (const message of messages) {
        let fileExtras = null;
        if (message.files && message.files.length > 0) {
            const uploadedFiles = await processFileAttachments(message.files);
            if (uploadedFiles.length > 0) {
                fileExtras = buildFileExtras(uploadedFiles);
            }
        }

        await adapter.sendUserMessage(message.text || '');

        if (fileExtras) {
            const userMessageIndex = adapter.getChatLength() - 1;
            const userMessage = adapter.getMessage(userMessageIndex);

            if (userMessage && userMessage.is_user) {
                userMessage.extra = userMessage.extra || {};
                Object.assign(userMessage.extra, fileExtras);

                try {
                    const messageElement = adapter.getMessageElement(userMessageIndex);
                    if (messageElement.length > 0) {
                        adapter.appendMediaToMessage(userMessage, messageElement, false);
                    }
                } catch (renderError) {
                    log('error', `Failed to render media: ${renderError.message}`);
                }

                try {
                    await adapter.saveChat();
                } catch (saveError) {
                    log('error', `Failed to save chat: ${saveError.message}`);
                }
            }
        }
    }

    await setupAndRunGeneration(chatId, botId, characterName, startMessageIndex);
}

// =============================================================================
// Final Message Handling
// =============================================================================

/**
 * Handles final message after generation.
 * @param {number} lastMessageIdInChatArray - Last message ID.
 */
async function handleFinalMessage(lastMessageIdInChatArray) {
    log('log', `handleFinalMessage called with index: ${lastMessageIdInChatArray}`);

    if (!bridgeClient.isConnected() || !activeRequest) {
        log('warn', 'handleFinalMessage early return - not connected or no active request');
        return;
    }

    const lastMessageIndex = lastMessageIdInChatArray - 1;
    if (lastMessageIndex < 0) {
        return;
    }

    await new Promise((resolve) => setTimeout(resolve, 100));

    const lastMessage = adapter.getMessage(lastMessageIndex);
    const startIndex = activeRequest.startMessageIndex || 0;
    const mediaItems = scanMessagesForMedia(startIndex, adapter.getChatLength());

    if (lastMessage && !lastMessage.is_user && !lastMessage.is_system) {
        const messageElement = adapter.getMessageElement(lastMessageIndex);

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

            log('log', `Sending final message with ${images.length} images`);

            if (activeRequest.isStreaming) {
                bridgeClient.sendFinalMessageUpdate(
                    activeRequest.chatId,
                    activeRequest.botId,
                    renderedText,
                    images
                );
            } else {
                bridgeClient.sendAiReply(
                    activeRequest.chatId,
                    activeRequest.botId,
                    renderedText,
                    images
                );
            }

            activeRequest = null;
        }
    }
}

// =============================================================================
// Bridge Client Message Handling
// =============================================================================

/**
 * Handles messages from the bridge client.
 * @param {Object} data - Message data.
 */
async function handleBridgeMessage(data) {
    try {
        if (data.type === 'execute_command') {
            await handleExecuteCommand(data);
            return;
        }

        if (data.type === 'user_message') {
            await handleUserMessage(data);
            return;
        }
    } catch (error) {
        log('error', 'Error processing message:', error);
        if (data && data.chatId && data.botId) {
            bridgeClient.sendErrorMessage(
                data.chatId,
                data.botId,
                'An internal error occurred while processing your request.'
            );
        }
    }
}

// =============================================================================
// Connection Management
// =============================================================================

/**
 * Connects to the bridge server.
 */
function connect() {
    const url = settingsManager.getBridgeUrl();
    bridgeClient.connect(url);
}

/**
 * Disconnects from the bridge server.
 */
function disconnect() {
    bridgeClient.disconnect();
}

// =============================================================================
// Initialization
// =============================================================================

jQuery(async () => {
    log('log', 'Initializing extension...');

    try {
        adapter = new SillyTavernAdapter();

        const context = adapter.getContext();
        settingsManager = new SettingsManager(
            MODULE_NAME,
            context.extensionSettings,
            context.saveSettingsDebounced
        );

        bridgeClient = new BridgeClient();

        bridgeClient.on(BRIDGE_EVENTS.CONNECTED, () => {
            updateStatus('Connected', 'green');
        });

        bridgeClient.on(BRIDGE_EVENTS.DISCONNECTED, () => {
            updateStatus('Disconnected', 'red');
            activeRequest = null;
        });

        bridgeClient.on(BRIDGE_EVENTS.ERROR, () => {
            updateStatus('Connection error', 'red');
            activeRequest = null;
        });

        bridgeClient.on(BRIDGE_EVENTS.MESSAGE, handleBridgeMessage);

        const eventTypes = adapter.getEventTypes();
        adapter.addEventListener(eventTypes.GENERATION_ENDED, handleFinalMessage);
        adapter.addEventListener(eventTypes.GENERATION_STOPPED, handleFinalMessage);

        adapter.addEventListener('sd_prompt_processing', () => {
            if (activeRequest) {
                log('log', 'Image generation started, sending chat action');
                bridgeClient.sendChatAction(activeRequest.chatId, activeRequest.botId, 'upload_photo');
            }
        });

        log('log', 'Loading settings UI...');
        const settingsHtml = await $.get(`/scripts/extensions/third-party/${MODULE_NAME}/settings.html`);
        $('#extensions_settings').append(settingsHtml);
        log('log', 'Settings UI loaded.');

        $('#telegram_bridge_url').val(settingsManager.getBridgeUrl());
        $('#telegram_auto_connect').prop('checked', settingsManager.getAutoConnect());

        $('#telegram_bridge_url').on('input', function () {
            settingsManager.setBridgeUrl($(this).val());
        });

        $('#telegram_auto_connect').on('change', function () {
            const enabled = $(this).prop('checked');
            log('log', `Auto-connect setting changed to: ${enabled}`);
            settingsManager.setAutoConnect(enabled);
        });

        $('#telegram_connect_button').on('click', connect);
        $('#telegram_disconnect_button').on('click', disconnect);

        if (settingsManager.getAutoConnect()) {
            log('log', 'Auto-connect enabled, connecting...');
            connect();
        }

        log('log', 'Extension loaded.');
    } catch (error) {
        log('error', 'Failed to initialize extension:', error);
    }
});
