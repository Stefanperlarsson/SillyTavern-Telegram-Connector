/**
 * Media handling utilities for image/file processing
 * @module utils/mediaUtils
 */

import { Logger } from './logger.js';
import { MIME_EXTENSION_MAP } from '../constants/index.js';
import { saveBase64AsFile } from '../../../../utils.js';

/**
 * @typedef {Object} MediaItem
 * @property {string} type - Media type ('image', 'video', 'audio')
 * @property {string} url - Media URL (relative path or base64)
 * @property {string} [title] - Optional title/prompt
 */

/**
 * @typedef {Object} UploadedFile
 * @property {string} url - URL path to the uploaded file
 * @property {string} type - 'image' | 'video' | 'audio' | 'file'
 * @property {string} fileName - Original file name
 * @property {string} mimeType - MIME type
 */

/**
 * Fetches an image from a URL and converts it to base64
 * @param {string} imageUrl - The image URL (relative or absolute)
 * @returns {Promise<{base64: string, mimeType: string}|null>} Base64 data or null on error
 */
export async function fetchImageAsBase64(imageUrl) {
    try {
        // Handle relative URLs by prepending the origin
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
                // reader.result is "data:image/png;base64,xxxxx"
                // Extract just the base64 part
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
 * @returns {MediaItem[]} Array of media items found
 */
export function scanMessagesForMedia(startIndex, endIndex) {
    const context = SillyTavern.getContext();
    const mediaItems = [];
    
    Logger.debug(`scanMessagesForMedia: checking messages ${startIndex} to ${endIndex - 1}`);
    
    for (let i = startIndex; i < endIndex; i++) {
        const msg = context.chat[i];
        
        // Skip user messages - we don't want to send user's own images back to them
        if (msg?.is_user) {
            Logger.debug(`  Message ${i}: skipping (is_user=true)`);
            continue;
        }
        
        const hasMedia = msg?.extra?.media?.length > 0;
        Logger.debug(`  Message ${i}: hasMedia=${hasMedia}, is_user=${msg?.is_user}, is_system=${msg?.is_system}`);
        
        if (hasMedia) {
            for (const media of msg.extra.media) {
                Logger.debug(`    Media found: type=${media.type}, hasUrl=${!!media.url}, urlLen=${media.url?.length}`);
                if (media.type === 'image' && media.url) {
                    mediaItems.push({
                        type: media.type,
                        url: media.url,
                        title: media.title || ''
                    });
                    Logger.debug(`    -> Added to mediaItems`);
                }
            }
        }
    }
    
    Logger.debug(`scanMessagesForMedia: returning ${mediaItems.length} items`);
    return mediaItems;
}

/**
 * Processes file attachments from Telegram and uploads them to SillyTavern
 * @param {Array<{base64: string, mimeType: string, fileName: string}>} files - Files from Telegram
 * @returns {Promise<UploadedFile[]>} Array of uploaded file info
 */
export async function processFileAttachments(files) {
    const uploaded = [];
    
    Logger.info(`Processing ${files.length} file attachment(s) from Telegram`);
    
    for (const file of files) {
        try {
            Logger.debug(`Uploading file: ${file.fileName} (${file.mimeType}), base64 length: ${file.base64.length}`);
            
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
                ext = MIME_EXTENSION_MAP[file.mimeType] || 'bin';
            }
            
            Logger.debug(`File type: ${isImage ? 'image' : isVideo ? 'video' : isAudio ? 'audio' : 'file'}, extension: ${ext}`);
            
            // Upload to SillyTavern server using saveBase64AsFile
            // Parameters: (base64Data, uniqueId, prefix, extension)
            const uniqueId = `${Date.now()}_${Math.random().toString(36).substring(2, 8)}`;
            const url = await saveBase64AsFile(file.base64, uniqueId, 'telegram', ext);
            
            Logger.debug(`File uploaded successfully: ${url}`);
            
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
    
    Logger.info(`Successfully uploaded ${uploaded.length}/${files.length} files`);
    return uploaded;
}

/**
 * Builds the extra object for a user message with file attachments
 * @param {UploadedFile[]} uploadedFiles - Array of uploaded file info
 * @returns {Object} Extra object to merge into message
 */
export function buildFileExtras(uploadedFiles) {
    const extras = {};
    
    // Separate files by type
    const images = uploadedFiles.filter(f => f.type === 'image');
    const videos = uploadedFiles.filter(f => f.type === 'video');
    const audios = uploadedFiles.filter(f => f.type === 'audio');
    const otherFiles = uploadedFiles.filter(f => f.type === 'file');
    
    Logger.debug(`Building extras: ${images.length} images, ${videos.length} videos, ${audios.length} audio, ${otherFiles.length} other`);
    
    // Always use media array for images (ST rejects extra.image, requires extra.media)
    if (images.length > 0) {
        extras.media = images.map(img => ({
            url: img.url,
            type: 'image',
            title: '',
        }));
        Logger.debug(`Set ${images.length} image(s) via media array`);
    }
    
    // Add videos to media array
    if (videos.length > 0) {
        const videoMedia = videos.map(v => ({
            url: v.url,
            type: 'video',
            title: '',
        }));
        extras.media = (extras.media || []).concat(videoMedia);
        Logger.debug(`Added ${videos.length} video(s) to media array`);
    }
    
    // Add audio files to media array
    if (audios.length > 0) {
        const audioMedia = audios.map(a => ({
            url: a.url,
            type: 'audio',
            title: '',
        }));
        extras.media = (extras.media || []).concat(audioMedia);
        Logger.debug(`Added ${audios.length} audio file(s) to media array`);
    }
    
    // For other files - ST uses extra.file for single file attachment
    if (otherFiles.length === 1) {
        extras.file = {
            url: otherFiles[0].url,
            name: otherFiles[0].fileName,
            size: 0, // We don't have the exact size, but ST may not require it
        };
        Logger.debug(`Set single file attachment: ${otherFiles[0].fileName}`);
    } else if (otherFiles.length > 1) {
        // For multiple files, we might need a different approach
        // For now, only attach the first one and log a warning
        extras.file = {
            url: otherFiles[0].url,
            name: otherFiles[0].fileName,
            size: 0,
        };
        Logger.warn(`Multiple non-media files received, only attaching the first: ${otherFiles[0].fileName}`);
    }
    
    Logger.debug(`Built extras object:`, JSON.stringify(extras, null, 2));
    return extras;
}
