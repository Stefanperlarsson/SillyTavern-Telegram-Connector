import { Logger } from '../utils/logger.js';
import { selectCharacterById } from "../../../../../script.js";

export class CharacterService {
    /**
     * Finds a character by name in the SillyTavern character list
     * @param {string} characterName - Name of the character to find
     * @returns {{found: boolean, index: number, message: string}}
     */
    findCharacterByName(characterName) {
        const context = SillyTavern.getContext();
        const characters = context.characters;

        if (!characters || !Array.isArray(characters)) {
            return {
                found: false,
                index: -1,
                message: 'Character list not available.'
            };
        }

        // Try exact match first
        let index = characters.findIndex(character => character.name === characterName);

        // Try case-insensitive match
        if (index === -1) {
            index = characters.findIndex(character => 
                character.name.toLowerCase() === characterName.toLowerCase()
            );
        }

        if (index !== -1) {
            return {
                found: true,
                index: index,
                message: 'Success'
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
    isCurrentCharacter(characterName) {
        const context = SillyTavern.getContext();
        if (context.characterId === undefined || context.characterId === null) {
            return false;
        }
        const currentCharacter = context.characters[context.characterId];
        if (!currentCharacter) {
            return false;
        }
        return currentCharacter.name === characterName ||
               currentCharacter.name.toLowerCase() === characterName.toLowerCase();
    }

    /**
     * Switches to a character by name
     * @param {string} characterName - Name of the character to switch to
     * @returns {Promise<{success: boolean, message: string}>}
     */
    async switchToCharacter(characterName) {
        // Check if we're already on the correct character
        if (this.isCurrentCharacter(characterName)) {
            Logger.info(`Already on character "${characterName}", no switch needed`);
            return {
                success: true,
                message: `Already chatting with ${characterName}.`
            };
        }

        // Find the character
        const searchResult = this.findCharacterByName(characterName);
        if (!searchResult.found) {
            Logger.error(searchResult.message);
            return {
                success: false,
                message: searchResult.message
            };
        }

        // Perform the switch
        try {
            Logger.info(`Switching to character "${characterName}" (index: ${searchResult.index})`);
            await selectCharacterById(searchResult.index);
            Logger.info(`Successfully switched to character "${characterName}"`);
            return {
                success: true,
                message: `Switched to ${characterName}.`
            };
        } catch (error) {
            Logger.error(`Failed to switch to character "${characterName}":`, error);
            return {
                success: false,
                message: `Failed to switch to ${characterName}: ${error.message}`
            };
        }
    }
}

export const characterService = new CharacterService();
