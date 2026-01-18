/**
 * @fileoverview Anti-Corruption Layer for SillyTavern globals.
 * All SillyTavern API access must go through this adapter.
 * @module extension/adapters/sillyTavernAdapter
 */

/* global SillyTavern, $ */

// Import SillyTavern public API
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
    saveChatConditional,
} from '../../../../../script.js';

import { saveBase64AsFile } from '../../../../utils.js';

/**
 * Adapter class providing a clean interface to SillyTavern APIs.
 * @class
 */
class SillyTavernAdapter {
    /**
     * Creates a new SillyTavernAdapter instance.
     */
    constructor() {
        /** @type {string} */
        this._moduleName = 'SillyTavern-Telegram-Connector';
    }

    /**
     * Gets the current SillyTavern context.
     * @returns {Object}
     */
    getContext() {
        return SillyTavern.getContext();
    }

    /**
     * Gets extension settings from context.
     * @returns {Object}
     */
    getExtensionSettings() {
        return this.getContext().extensionSettings;
    }

    /**
     * Gets the delete last message function from context.
     * @returns {Function}
     */
    getDeleteLastMessage() {
        return this.getContext().deleteLastMessage;
    }

    /**
     * Gets the save settings debounced function from context.
     * @returns {Function}
     */
    getSaveSettingsDebounced() {
        return this.getContext().saveSettingsDebounced;
    }

    /**
     * Gets the execute slash commands function from context.
     * @returns {Function}
     */
    getExecuteSlashCommands() {
        return this.getContext().executeSlashCommands;
    }

    /**
     * Adds an event listener to the SillyTavern event source.
     * @param {string} eventType - Event type constant.
     * @param {Function} callback - Event handler.
     */
    addEventListener(eventType, callback) {
        eventSource.on(eventType, callback);
    }

    /**
     * Adds a one-time event listener.
     * @param {string} eventType - Event type constant.
     * @param {Function} callback - Event handler.
     */
    addEventListenerOnce(eventType, callback) {
        eventSource.once(eventType, callback);
    }

    /**
     * Removes an event listener.
     * @param {string} eventType - Event type constant.
     * @param {Function} callback - Event handler to remove.
     */
    removeEventListener(eventType, callback) {
        eventSource.removeListener(eventType, callback);
    }

    /**
     * Gets event type constants.
     * @returns {Object} Event types object.
     */
    getEventTypes() {
        return event_types;
    }

    /**
     * Saves the current chat.
     * @returns {Promise<void>}
     */
    async saveChat() {
        await saveChatConditional();
    }

    /**
     * Gets past character chats.
     * @param {number} characterId - Character ID.
     * @returns {Promise<Array>}
     */
    async getPastChats(characterId) {
        return await getPastCharacterChats(characterId);
    }

    /**
     * Sends a message as the user.
     * @param {string} text - Message text.
     * @returns {Promise<void>}
     */
    async sendUserMessage(text) {
        await sendMessageAsUser(text);
    }

    /**
     * Starts a new chat.
     * @param {boolean} [deleteCurrentChat=false] - Whether to delete current chat.
     * @returns {Promise<void>}
     */
    async startNewChat(deleteCurrentChat = false) {
        await doNewChat({ deleteCurrentChat });
    }

    /**
     * Selects a character by index.
     * @param {number} characterIndex - Character index.
     * @returns {Promise<void>}
     */
    async selectCharacter(characterIndex) {
        await selectCharacterById(characterIndex);
    }

    /**
     * Opens a character chat by name.
     * @param {string} chatName - Chat file name.
     * @returns {Promise<void>}
     */
    async openChat(chatName) {
        await openCharacterChat(chatName);
    }

    /**
     * Triggers AI generation.
     * @param {AbortSignal} [signal] - Abort signal.
     * @returns {Promise<void>}
     */
    async generate(signal) {
        const abortController = new AbortController();
        setExternalAbortController(abortController);
        await Generate('normal', { signal: signal || abortController.signal });
    }

    /**
     * Appends media to a message in the UI.
     * @param {Object} message - Message object.
     * @param {JQuery} messageElement - jQuery element.
     * @param {boolean} adjustScrollPosition - Whether to adjust scroll.
     */
    appendMediaToMessage(message, messageElement, adjustScrollPosition) {
        appendMediaToMessage(message, messageElement, adjustScrollPosition);
    }

    /**
     * Saves a base64 file to the server.
     * @param {string} base64Data - Base64 encoded data.
     * @param {string} uniqueId - Unique identifier.
     * @param {string} prefix - File prefix.
     * @param {string} extension - File extension.
     * @returns {Promise<string>} URL of saved file.
     */
    async saveFile(base64Data, uniqueId, prefix, extension) {
        return await saveBase64AsFile(base64Data, uniqueId, prefix, extension);
    }

    /**
     * Deletes the last message from the chat.
     * @returns {Promise<void>}
     */
    async deleteLastMessage() {
        const deleteFunction = this.getDeleteLastMessage();
        if (deleteFunction) {
            await deleteFunction();
        }
    }

    /**
     * Executes a slash command.
     * @param {string} command - Command string.
     * @returns {Promise<void>}
     */
    async executeSlashCommand(command) {
        const executeFunction = this.getExecuteSlashCommands();
        if (executeFunction) {
            await executeFunction(command);
        }
    }

    /**
     * Finds a character by name.
     * @param {string} characterName - Name to search for.
     * @returns {{found: boolean, index: number, message: string}}
     */
    findCharacterByName(characterName) {
        const context = this.getContext();
        const characters = context.characters;

        // Exact match
        const exactMatch = characters.find((character) => character.name === characterName);
        if (exactMatch) {
            const index = characters.indexOf(exactMatch);
            return {
                found: true,
                index: index,
                message: `Found character "${characterName}" at index ${index}`,
            };
        }

        // Case-insensitive match
        const caseInsensitiveMatch = characters.find(
            (character) => character.name.toLowerCase() === characterName.toLowerCase()
        );
        if (caseInsensitiveMatch) {
            const index = characters.indexOf(caseInsensitiveMatch);
            return {
                found: true,
                index: index,
                message: `Found character "${caseInsensitiveMatch.name}" at index ${index} (case-insensitive match)`,
            };
        }

        return {
            found: false,
            index: -1,
            message: `Character "${characterName}" not found. Please check the character name in your bot configuration.`,
        };
    }

    /**
     * Checks if the current character matches the given name.
     * @param {string} characterName - Character name to check.
     * @returns {boolean}
     */
    isCurrentCharacter(characterName) {
        const context = this.getContext();
        if (context.characterId === undefined || context.characterId === null) {
            return false;
        }
        const currentCharacter = context.characters[context.characterId];
        if (!currentCharacter) {
            return false;
        }
        return (
            currentCharacter.name === characterName ||
            currentCharacter.name.toLowerCase() === characterName.toLowerCase()
        );
    }

    /**
     * Gets the current chat array.
     * @returns {Array}
     */
    getChat() {
        return this.getContext().chat;
    }

    /**
     * Gets the current chat length.
     * @returns {number}
     */
    getChatLength() {
        return this.getChat().length;
    }

    /**
     * Gets a message by index.
     * @param {number} index - Message index.
     * @returns {Object|undefined}
     */
    getMessage(index) {
        return this.getChat()[index];
    }

    /**
     * Gets the current character ID.
     * @returns {number|undefined}
     */
    getCurrentCharacterId() {
        return this.getContext().characterId;
    }

    /**
     * Gets a jQuery message element by index.
     * @param {number} index - Message index.
     * @returns {JQuery}
     */
    getMessageElement(index) {
        return $(`#chat .mes[mesid="${index}"]`);
    }
}

export default SillyTavernAdapter;
