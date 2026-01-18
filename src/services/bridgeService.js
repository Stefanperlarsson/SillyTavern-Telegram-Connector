/**
 * Bridge service for handling communication between Telegram and SillyTavern
 * @module services/bridgeService
 */

import { Logger } from '../utils/logger.js';
import { EVENTS, COMMANDS } from '../constants/index.js';
import { webSocketService } from './webSocketService.js';
import { characterService } from './characterService.js';
import {
    scanMessagesForMedia,
    fetchImageAsBase64,
    processFileAttachments,
    buildFileExtras,
} from '../utils/mediaUtils.js';
import {
    eventSource,
    event_types,
    getPastCharacterChats,
    sendMessageAsUser,
    doNewChat,
    openCharacterChat,
    Generate,
    setExternalAbortController,
    appendMediaToMessage,
} from '../../../../../script.js';

const { deleteLastMessage, executeSlashCommands } = SillyTavern.getContext();

/**
 * @typedef {Object} ActiveRequest
 * @property {number} chatId - Telegram chat ID
 * @property {string} botId - Bot identifier
 * @property {string} characterName - Character being used
 * @property {boolean} isStreaming - Whether streaming is active
 * @property {number} startMessageIndex - Chat index when request started
 * @property {Array} collectedMedia - Media collected during this request
 */

/**
 * Service for bridging Telegram messages with SillyTavern generation
 */
class BridgeService {
    constructor() {
        /** @type {ActiveRequest|null} */
        this.activeRequest = null;
        this._streamCallback = null;
        this._cleanupBound = this._cleanup.bind(this);
    }

    /**
     * Initializes event listeners for generation events
     */
    initialize() {
        eventSource.on(event_types.GENERATION_ENDED, (lastMessageId) => this.handleFinalMessage(lastMessageId));
        eventSource.on(event_types.GENERATION_STOPPED, (lastMessageId) => this.handleFinalMessage(lastMessageId));
        
        // Register event listener for image generation start
        eventSource.on('sd_prompt_processing', () => {
            if (this.activeRequest) {
                Logger.info('Image generation started, sending chat action to server');
                webSocketService.send({
                    type: EVENTS.CHAT_ACTION,
                    chatId: this.activeRequest.chatId,
                    botId: this.activeRequest.botId,
                    action: 'upload_photo'
                });
            }
        });
        
        Logger.info('BridgeService initialized');
    }

    /**
     * Handles data received from the WebSocket server
     * @param {Object} data - The message data
     */
    async handleMessage(data) {
        if (!data || !data.type) return;

        try {
            switch (data.type) {
                case EVENTS.EXECUTE_COMMAND:
                    await this.handleExecuteCommand(data);
                    break;
                case EVENTS.USER_MESSAGE:
                    await this.handleUserMessage(data);
                    break;
                default:
                    Logger.warn(`Unhandled message type: ${data.type}`);
            }
        } catch (error) {
            Logger.error('Error processing message:', error);
            if (data.chatId && data.botId) {
                webSocketService.send({
                    type: EVENTS.ERROR_MESSAGE,
                    chatId: data.chatId,
                    botId: data.botId,
                    text: 'An internal error occurred while processing your request.'
                });
            }
        }
    }

    /**
     * Handles command execution requests
     * @param {Object} data - Command data from server
     */
    async handleExecuteCommand(data) {
        Logger.info(`Executing command: ${data.command}`, data);

        const { chatId, botId, command, args, characterName } = data;
        const isQueuedSwitch = data.isQueuedSwitch || false;

        // Send typing indicator
        webSocketService.send({ type: EVENTS.TYPING_ACTION, chatId, botId });

        const context = SillyTavern.getContext();
        let result = { success: false, message: 'Unknown command' };

        try {
            switch (command) {
                case COMMANDS.SWITCH_CHAR:
                    if (args && args.length > 0) {
                        const targetName = args.join(' ');
                        result = await characterService.switchToCharacter(targetName);
                    } else {
                        result = { success: false, message: 'No character name provided.' };
                    }
                    break;

                case COMMANDS.NEW_CHAT:
                    await doNewChat({ deleteCurrentChat: false });
                    result = { success: true, message: 'New chat has been started.' };
                    break;

                case COMMANDS.LIST_CHATS:
                    result = await this._handleListChats(context);
                    break;

                case COMMANDS.SWITCH_CHAT:
                    result = await this._handleSwitchChat(args);
                    break;

                case COMMANDS.DELETE_MESSAGES:
                    result = await this._handleDeleteMessages(args);
                    break;

                case COMMANDS.TRIGGER_GENERATION:
                    result = this._handleTriggerGeneration(chatId, botId, characterName);
                    break;

                case COMMANDS.SWITCH_MODEL:
                    result = await this._handleSwitchModel(args);
                    break;

                case COMMANDS.PING:
                    result = { success: true, message: 'Pong! The extension is connected and active.' };
                    break;

                default:
                    // Handle numbered commands (switchchat_N)
                    const chatMatch = command.match(/^switchchat_(\d+)$/);
                    if (chatMatch) {
                        result = await this._handleSwitchChatByIndex(context, chatMatch[1]);
                    } else {
                        result = { success: false, message: `Unknown command: ${command}` };
                    }
            }
        } catch (error) {
            Logger.error(`Error executing command ${command}:`, error);
            result = { success: false, message: `Error: ${error.message}` };
        }

        // Send command result back to server
        webSocketService.send({
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
     * Lists past chats for the current character
     * @param {Object} context - SillyTavern context
     * @returns {Promise<{success: boolean, message: string}>}
     */
    async _handleListChats(context) {
        if (context.characterId === undefined) {
            return { success: false, message: 'No character selected.' };
        }

        const chatFiles = await getPastCharacterChats(context.characterId);
        if (!chatFiles || chatFiles.length === 0) {
            return { success: true, message: 'No chat logs found for this character.' };
        }

        let replyText = 'Chat logs for current character:\n\n';
        chatFiles.forEach((chat, index) => {
            const chatName = chat.file_name.replace('.jsonl', '');
            replyText += `${index + 1}. /switchchat_${index + 1} - ${chatName}\n`;
        });
        replyText += '\nUse /switchchat_<number> or /switchchat <name> to switch chats';
        return { success: true, message: replyText };
    }

    /**
     * Switches to a chat by name
     * @param {string[]} args - Command arguments
     * @returns {Promise<{success: boolean, message: string}>}
     */
    async _handleSwitchChat(args) {
        if (!args || args.length === 0) {
            return { success: false, message: 'Please provide a chat log name.' };
        }

        const targetChatFile = args.join(' ');
        try {
            await openCharacterChat(targetChatFile);
            return { success: true, message: `Loaded chat log: ${targetChatFile}` };
        } catch (err) {
            Logger.error('Failed to load chat:', err);
            return { success: false, message: `Failed to load chat log "${targetChatFile}".` };
        }
    }

    /**
     * Switches to a chat by index
     * @param {Object} context - SillyTavern context
     * @param {string} indexStr - Chat index as string
     * @returns {Promise<{success: boolean, message: string}>}
     */
    async _handleSwitchChatByIndex(context, indexStr) {
        if (context.characterId === undefined) {
            return { success: false, message: 'No character selected.' };
        }

        const index = parseInt(indexStr) - 1;
        const chatFiles = await getPastCharacterChats(context.characterId);

        if (index >= 0 && index < chatFiles.length) {
            const targetChat = chatFiles[index];
            const chatName = targetChat.file_name.replace('.jsonl', '');
            try {
                await openCharacterChat(chatName);
                return { success: true, message: `Loaded chat log: ${chatName}` };
            } catch (err) {
                Logger.error('Failed to load chat:', err);
                return { success: false, message: 'Failed to load chat log.' };
            }
        }

        return {
            success: false,
            message: `Invalid chat log number: ${index + 1}. Use /listchats to see available chats.`
        };
    }

    /**
     * Deletes messages from the chat
     * @param {string[]} args - Command arguments
     * @returns {Promise<{success: boolean, message: string}>}
     */
    async _handleDeleteMessages(args) {
        const count = args && args.length > 0 ? parseInt(args[0]) : 1;
        let deleted = 0;

        for (let i = 0; i < count; i++) {
            // Safety check: don't delete if chat is empty
            if (SillyTavern.getContext().chat.length === 0) break;
            try {
                await deleteLastMessage();
                deleted++;
            } catch (e) {
                Logger.error('Failed to delete message:', e);
                break;
            }
        }

        return { success: true, message: `Deleted ${deleted} message(s).` };
    }

    /**
     * Triggers AI generation without a user message
     * @param {number} chatId - Telegram chat ID
     * @param {string} botId - Bot identifier
     * @param {string} characterName - Character name
     * @returns {{success: boolean, message: string}}
     */
    _handleTriggerGeneration(chatId, botId, characterName) {
        if (this.activeRequest) {
            return { success: false, message: 'Generation already in progress.' };
        }

        // Run generation in background
        const startIndex = SillyTavern.getContext().chat.length;
        this.setupAndRunGeneration(chatId, botId, characterName, startIndex);

        return { success: true, message: 'Generation triggered.' };
    }

    /**
     * Switches the model/profile
     * @param {string[]} args - Command arguments
     * @returns {Promise<{success: boolean, message: string}>}
     */
    async _handleSwitchModel(args) {
        if (!args || args.length === 0) {
            return { success: false, message: 'No model profile provided.' };
        }

        const profileName = args.join(' ');
        try {
            Logger.info(`Switching to profile via slash command: /profile ${profileName}`);
            await executeSlashCommands(`/profile ${profileName}`);
            return { success: true, message: `Switched to profile: ${profileName}` };
        } catch (err) {
            Logger.error(`Failed to switch to profile "${profileName}":`, err);
            return { success: false, message: `Failed to switch to profile "${profileName}".` };
        }
    }

    /**
     * Handles incoming user messages (requests for AI generation)
     * @param {Object} data - Message data from server
     */
    async handleUserMessage(data) {
        Logger.info('Received user message for generation', data);

        const { chatId, botId, characterName } = data;

        // Get current chat length to track new messages
        let context = SillyTavern.getContext();
        const startMessageIndex = context.chat.length;

        // Normalize input to an array of messages
        const messages = data.messages || [{ text: data.text, files: data.files }];
        Logger.info(`Processing batch of ${messages.length} message(s)`);

        for (const msg of messages) {
            Logger.debug(`Processing message: text="${msg.text?.substring(0, 20)}...", files=${msg.files?.length || 0}`);

            // Process file attachments if present
            let fileExtras = null;
            if (msg.files && msg.files.length > 0) {
                Logger.info(`Processing ${msg.files.length} file attachment(s)...`);
                const uploadedFiles = await processFileAttachments(msg.files);
                if (uploadedFiles.length > 0) {
                    fileExtras = buildFileExtras(uploadedFiles);
                }
            }

            // Add user message to SillyTavern
            await sendMessageAsUser(msg.text || '');

            // If we have file attachments, add them to the user message we just created
            if (fileExtras) {
                context = SillyTavern.getContext();
                const userMessageIndex = context.chat.length - 1;
                const userMessage = context.chat[userMessageIndex];

                if (userMessage && userMessage.is_user) {
                    Logger.debug(`Attaching file extras to user message at index ${userMessageIndex}`);

                    // Merge file extras into the message's extra object
                    userMessage.extra = userMessage.extra || {};
                    Object.assign(userMessage.extra, fileExtras);

                    // Render the media in the UI
                    try {
                        const messageElement = $(`#chat .mes[mesid="${userMessageIndex}"]`);
                        if (messageElement.length > 0) {
                            appendMediaToMessage(userMessage, messageElement, false);
                            Logger.debug(`Media rendered in UI for message ${userMessageIndex}`);
                        } else {
                            Logger.warn(`Could not find message element for index ${userMessageIndex}`);
                        }
                    } catch (renderError) {
                        Logger.error(`Failed to render media: ${renderError.message}`);
                    }

                    // Save the chat to persist the changes
                    try {
                        const { saveChatConditional } = await import('../../../../script.js');
                        await saveChatConditional();
                        Logger.debug('Chat saved with file attachments');
                    } catch (saveError) {
                        Logger.error(`Failed to save chat: ${saveError.message}`);
                    }
                } else {
                    Logger.warn(`Could not find user message to attach files. Index: ${userMessageIndex}, is_user: ${userMessage?.is_user}`);
                }
            }
        }

        // Set up active request tracking and trigger generation
        await this.setupAndRunGeneration(chatId, botId, characterName, startMessageIndex);
    }

    /**
     * Common logic to setup and run the generation process
     * @param {number} chatId - Telegram chat ID
     * @param {string} botId - Bot identifier
     * @param {string} characterName - Character being used
     * @param {number} startMessageIndex - Chat index when request started
     */
    async setupAndRunGeneration(chatId, botId, characterName, startMessageIndex) {
        // Set up active request tracking
        this.activeRequest = {
            chatId,
            botId,
            characterName,
            isStreaming: false,
            startMessageIndex,
            collectedMedia: []
        };

        // Send typing indicator
        webSocketService.send({ type: EVENTS.TYPING_ACTION, chatId, botId });

        // Set up streaming callback
        this._streamCallback = (cumulativeText) => {
            if (this.activeRequest) {
                this.activeRequest.isStreaming = true;
                webSocketService.send({
                    type: EVENTS.STREAM_CHUNK,
                    chatId: this.activeRequest.chatId,
                    botId: this.activeRequest.botId,
                    text: cumulativeText,
                });
            }
        };
        eventSource.on(event_types.STREAM_TOKEN_RECEIVED, this._streamCallback);

        // Define cleanup function
        let errorOccurred = false;

        // Listen for generation end events (once to avoid interference)
        eventSource.once(event_types.GENERATION_ENDED, this._cleanupBound);
        eventSource.once(event_types.GENERATION_STOPPED, this._cleanupBound);

        // Trigger generation
        try {
            Logger.info('Starting Generate() call...');
            const abortController = new AbortController();
            setExternalAbortController(abortController);
            await Generate('normal', { signal: abortController.signal });
            Logger.info('Generate() call completed');
        } catch (error) {
            Logger.error('Generate() error:', error);
            errorOccurred = true;

            // Delete all messages created since the request started
            const currentContext = SillyTavern.getContext();
            const messagesToDelete = currentContext.chat.length - startMessageIndex;

            Logger.info(`Cleaning up ${messagesToDelete} messages (from index ${startMessageIndex} to ${currentContext.chat.length - 1})`);

            // Delete messages in reverse order (newest first)
            for (let i = 0; i < messagesToDelete; i++) {
                try {
                    await deleteLastMessage();
                    Logger.debug(`Deleted message ${i + 1}/${messagesToDelete}`);
                } catch (deleteError) {
                    Logger.error(`Failed to delete message: ${deleteError.message}`);
                    break;
                }
            }

            // Send error message
            const errorMessage = `Sorry, an error occurred while generating a reply.\nYour previous message has been retracted, please retry or send different content.\n\nError details: ${error.message || 'Unknown error'}`;

            if (this.activeRequest) {
                webSocketService.send({
                    type: EVENTS.ERROR_MESSAGE,
                    chatId: this.activeRequest.chatId,
                    botId: this.activeRequest.botId,
                    text: errorMessage,
                });
            }

            this._cleanup();
            this.activeRequest = null;
        }
    }

    /**
     * Cleanup function for generation events
     */
    _cleanup() {
        if (this._streamCallback) {
            eventSource.removeListener(event_types.STREAM_TOKEN_RECEIVED, this._streamCallback);
            this._streamCallback = null;
        }

        if (this.activeRequest && this.activeRequest.isStreaming) {
            webSocketService.send({
                type: EVENTS.STREAM_END,
                chatId: this.activeRequest.chatId,
                botId: this.activeRequest.botId
            });
        }
    }

    /**
     * Handles the final message after generation completes
     * @param {number} lastMessageIdInChatArray - Index of the last message in the chat array
     */
    async handleFinalMessage(lastMessageIdInChatArray) {
        Logger.debug(`handleFinalMessage called with index: ${lastMessageIdInChatArray}, activeRequest:`, this.activeRequest);

        // Ensure we have an active request to respond to
        if (!webSocketService.isConnected() || !this.activeRequest) {
            Logger.warn(`handleFinalMessage early return - wsConnected: ${webSocketService.isConnected()}, activeRequest: ${!!this.activeRequest}`);
            return;
        }

        const lastMessageIndex = lastMessageIdInChatArray - 1;
        if (lastMessageIndex < 0) return;

        // Small delay to ensure DOM update is complete
        await new Promise(resolve => setTimeout(resolve, 100));

        const context = SillyTavern.getContext();
        const lastMessage = context.chat[lastMessageIndex];

        // Scan for media generated during this request
        const startIdx = this.activeRequest.startMessageIndex || 0;
        Logger.debug(`Scanning for media from index ${startIdx} to ${context.chat.length - 1} (chat length: ${context.chat.length})`);
        const mediaItems = scanMessagesForMedia(startIdx, context.chat.length);
        Logger.debug(`Found ${mediaItems.length} media items total`);

        // Debug: show what we found
        if (mediaItems.length > 0) {
            mediaItems.forEach((item, idx) => {
                Logger.debug(`  Media item ${idx}: type=${item.type}, url=${item.url?.substring(0, 50)}...`);
            });
        }

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

                // Fetch and convert images to base64 for transmission
                const images = [];
                for (const media of mediaItems) {
                    if (media.type === 'image') {
                        const imageData = await fetchImageAsBase64(media.url);
                        if (imageData) {
                            images.push({
                                base64: imageData.base64,
                                mimeType: imageData.mimeType,
                            });
                            Logger.debug(`Prepared image for sending: ${imageData.mimeType}, ${imageData.base64.length} chars`);
                        }
                    }
                }

                Logger.info(`Sending final message to bot ${this.activeRequest.botId} with ${images.length} images`);

                // Build the payload
                const payload = {
                    chatId: this.activeRequest.chatId,
                    botId: this.activeRequest.botId,
                    text: renderedText,
                    images: images.length > 0 ? images : undefined,
                };

                // Send appropriate message type based on streaming state
                if (this.activeRequest.isStreaming) {
                    webSocketService.send({
                        type: EVENTS.FINAL_MESSAGE_UPDATE,
                        ...payload,
                    });
                } else {
                    webSocketService.send({
                        type: EVENTS.AI_REPLY,
                        ...payload,
                    });
                }

                // Clear active request
                this.activeRequest = null;
            }
        }
    }
}

export const bridgeService = new BridgeService();
