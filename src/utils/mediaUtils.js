import { Logger } from './logger.js';

/**
 * Scans messages for media items
 * @param {number} startIndex - Index to start scanning from
 * @param {number} endIndex - Index to stop scanning
 * @returns {Array} List of found media items
 */
export function scanMessagesForMedia(startIndex, endIndex) {
    const context = SillyTavern.getContext();
    const mediaItems = [];

    for (let i = startIndex; i < endIndex; i++) {
        const message = context.chat[i];
        if (message && message.extra && message.extra.media) {
            for (const media of message.extra.media) {
                mediaItems.push(media);
            }
        }
    }

    return mediaItems;
}

/**
 * Fetches an image and converts it to base64
 * @param {string} url - The image URL
 * @returns {Promise<{base64: string, mimeType: string}|null>}
 */
export async function fetchImageAsBase64(url) {
    try {
        const response = await fetch(url);
        const blob = await response.blob();
        return new Promise((resolve) => {
            const reader = new FileReader();
            reader.onloadend = () => {
                const base64String = reader.result.split(',')[1];
                resolve({
                    base64: base64String,
                    mimeType: blob.type
                });
            };
            reader.onerror = () => {
                Logger.error(`Failed to read blob for URL: ${url}`);
                resolve(null);
            };
            reader.readAsDataURL(blob);
        });
    } catch (error) {
        Logger.error(`Failed to fetch image from URL: ${url}`, error);
        return null;
    }
}
