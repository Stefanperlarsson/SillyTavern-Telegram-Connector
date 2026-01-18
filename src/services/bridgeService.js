import { Logger } from '../utils/logger.js';
import { EVENTS, COMMANDS } from '../constants/system.js';
import { webSocketService } from './webSocketService.js';
import { characterService } from './characterService.js';
import { scanMessagesForMedia, fetchImageAsBase64 } from '../utils/mediaUtils.js';
import {
    getPastCharacterChats,
    sendMessageAsUser,
    doNewChat,
    Generate,
    appendMediaToMessage,
} from "../../../../script.js";

export class BridgeService {
    constructor() {
        this.activeRequest = null;
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
                    type: EVENTS.ERROR,
                    chatId: data.chatId,
                    botId: data.botId,
                    text: 'An internal error occurred while processing your request.'
                });
            }
        }
    }

    /**
     * Handles command execution requests
     * @param {Object} data 
     */
    async handleExecuteCommand(data) {
        Logger.info(`Executing command: ${data.command}`, data);

        const { chatId, botId, command, args } = data;
        const isQueuedSwitch = data.isQueuedSwitch || false;

        // Send typing indicator
        webSocketService.send({ type: EVENTS.TYPING, chatId, botId });

        let result = { success: false, message: 'Unknown command' };

        try {
            switch (command) {
                case 'switchchar':
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
                    result = await this.handleListChats();
                    break;

                case COMMANDS.PING:
                    result = { success: true, message: 'Pong! The extension is connected and active.' };
                    break;

                default:
                    Logger.warn(`Unsupported command: ${command}`);
            }
        } catch (error) {
            Logger.error(`Error executing command ${command}:`, error);
            result = { success: false, message: `Error: ${error.message}` };
        }

        webSocketService.send({
            type: EVENTS.COMMAND_EXECUTED,
            chatId,
            botId,
            command,
            ...result
        });
    }

    /**
     * Lists past chats for the current character
     */
    async handleListChats() {
        const context = SillyTavern.getContext();
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
     * Handles incoming user messages (requests for AI generation)
     * @param {Object} data 
     */
    async handleUserMessage(data) {
        Logger.info(`Handling user message from bot ${data.botId}`);

        const { chatId, botId, characterName, messages } = data;

        // 1. Ensure we are on the correct character
        if (!characterService.isCurrentCharacter(characterName)) {
            Logger.info(`Switching to character ${characterName} before generation`);
            const switchResult = await characterService.switchToCharacter(characterName);
            if (!switchResult.success) {
                webSocketService.send({
                    type: EVENTS.ERROR,
                    chatId,
                    botId,
                    text: `Failed to switch to character ${characterName}: ${switchResult.message}`
                });
                return;
            }
        }

        // 2. Set active request state
        this.activeRequest = {
            chatId,
            botId,
            characterName,
            isStreaming: false,
            startMessageIndex: SillyTavern.getContext().chat.length,
            collectedMedia: []
        };

        // 3. Process attachments if any
        if (data.images && data.images.length > 0) {
            for (const image of data.images) {
                await appendMediaToMessage(image.base64, image.mimeType);
            }
        }

        // 4. Send message to SillyTavern
        const text = messages.map(message => message.text).join('\n');
        await sendMessageAsUser(text);

        // 5. Trigger generation
        Generate();
    }

    /**
     * Handles the end of AI generation
     */
    async handleFinalMessage() {
        if (!this.activeRequest) return;

        const { chatId, botId, isStreaming, startMessageIndex } = this.activeRequest;

        // Small delay to ensure DOM update is complete
        await new Promise(resolve => setTimeout(resolve, 100));
        
        const context = SillyTavern.getContext();
        const lastMessageIndex = context.chat.length - 1;
        if (lastMessageIndex < 0) return;

        const lastMessage = context.chat[lastMessageIndex];

        // Scan for media generated during this request
        const mediaItems = scanMessagesForMedia(startMessageIndex, context.chat.length);
        
        if (lastMessage && !lastMessage.is_user && !lastMessage.is_system) {
            const messageElement = $(`#chat .mes[mesid="${lastMessageIndex}"]`);
            if (messageElement.length === 0) return;

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
                chatId,
                botId,
                text: renderedText,
                images: images.length > 0 ? images : undefined,
            };

            webSocketService.send({
                type: isStreaming ? EVENTS.FINAL_MESSAGE : EVENTS.AI_REPLY,
                ...payload,
            });

            this.activeRequest = null;
        }
    }
}

export const bridgeService = new BridgeService();
