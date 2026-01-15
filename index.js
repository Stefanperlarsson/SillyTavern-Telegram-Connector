// index.js

// Only destructure properties that actually exist in the object returned by getContext()
const {
    extensionSettings,
    deleteLastMessage, // Import function to delete the last message
    saveSettingsDebounced, // Import function to save settings
} = SillyTavern.getContext();

// The getContext function is part of the global SillyTavern object, we don't need to import it from elsewhere
// Just call SillyTavern.getContext() directly when needed

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

const MODULE_NAME = 'SillyTavern-Telegram-Connector';
const DEFAULT_SETTINGS = {
    bridgeUrl: 'ws://127.0.0.1:2333',
    autoConnect: true,
};

let ws = null; // WebSocket instance
let lastProcessedChatId = null; // Used to store the last processed Telegram chatId

// Add a global variable to track whether currently in streaming mode
let isStreamingMode = false;

// --- Utility Functions ---
function getSettings() {
    if (!extensionSettings[MODULE_NAME]) {
        extensionSettings[MODULE_NAME] = { ...DEFAULT_SETTINGS };
    }
    return extensionSettings[MODULE_NAME];
}

function updateStatus(message, color) {
    const statusEl = document.getElementById('telegram_connection_status');
    if (statusEl) {
        statusEl.textContent = `Status: ${message}`;
        statusEl.style.color = color;
    }
}

function reloadPage() {
    window.location.reload();
}
// ---

// Connect to WebSocket server
function connect() {
    if (ws && ws.readyState === WebSocket.OPEN) {
        console.log('[Telegram Bridge] Already connected');
        return;
    }

    const settings = getSettings();
    if (!settings.bridgeUrl) {
        updateStatus('URL not set!', 'red');
        return;
    }

    updateStatus('Connecting...', 'orange');
    console.log(`[Telegram Bridge] Connecting to ${settings.bridgeUrl}...`);

    ws = new WebSocket(settings.bridgeUrl);

    ws.onopen = () => {
        console.log('[Telegram Bridge] Connection successful!');
        updateStatus('Connected', 'green');
    };

    ws.onmessage = async (event) => {
        let data;
        try {
            data = JSON.parse(event.data);

            // --- User Message Handling ---
            if (data.type === 'user_message') {
                console.log('[Telegram Bridge] Received user message.', data);

                // Store the currently processing chatId
                lastProcessedChatId = data.chatId;

                // By default, assume it's not streaming mode
                isStreamingMode = false;

                // 1. Immediately send "typing" status to Telegram (regardless of streaming or not)
                if (ws && ws.readyState === WebSocket.OPEN) {
                    ws.send(JSON.stringify({ type: 'typing_action', chatId: data.chatId }));
                }

                // 2. Add user message to SillyTavern
                await sendMessageAsUser(data.text);

                // 3. Set up streaming callback
                const streamCallback = (cumulativeText) => {
                    // Mark as streaming mode
                    isStreamingMode = true;
                    // Send each text chunk to the server via WebSocket
                    if (ws && ws.readyState === WebSocket.OPEN) {
                        ws.send(JSON.stringify({
                            type: 'stream_chunk',
                            chatId: data.chatId,
                            text: cumulativeText,
                        }));
                    }
                };
                eventSource.on(event_types.STREAM_TOKEN_RECEIVED, streamCallback);

                // 4. Define a cleanup function
                const cleanup = () => {
                    eventSource.removeListener(event_types.STREAM_TOKEN_RECEIVED, streamCallback);
                    if (ws && ws.readyState === WebSocket.OPEN && isStreamingMode) {
                        // Only send stream_end if there's no error and it's actually in streaming mode
                        if (!data.error) {
                            ws.send(JSON.stringify({ type: 'stream_end', chatId: data.chatId }));
                        }
                    }
                    // Note: Don't reset isStreamingMode here, let the handleFinalMessage function handle it
                };

                // 5. Listen for generation end event, ensure cleanup is executed regardless of success or failure
                // Note: We now use once to ensure this listener only executes once, avoiding interference with subsequent global listeners
                eventSource.once(event_types.GENERATION_ENDED, cleanup);
                // Handle manual generation stop
                eventSource.once(event_types.GENERATION_STOPPED, cleanup);

                // 6. Trigger SillyTavern's generation process, wrapped in try...catch
                try {
                    const abortController = new AbortController();
                    setExternalAbortController(abortController);
                    await Generate('normal', { signal: abortController.signal });
                } catch (error) {
                    console.error("[Telegram Bridge] Generate() error:", error);

                    // a. Delete the user message that caused the error from SillyTavern chat history
                    await deleteLastMessage();
                    console.log('[Telegram Bridge] Deleted user message that caused the error.');

                    // b. Prepare and send error message to server
                    const errorMessage = `Sorry, an error occurred while the AI was generating a reply.\nYour previous message has been retracted, please retry or send different content.\n\nError details: ${error.message || 'Unknown error'}`;
                    if (ws && ws.readyState === WebSocket.OPEN) {
                        ws.send(JSON.stringify({
                            type: 'error_message',
                            chatId: data.chatId,
                            text: errorMessage,
                        }));
                    }

                    // c. Mark error so cleanup function knows
                    data.error = true;
                    cleanup(); // Ensure listener cleanup
                }

                return;
            }

            // --- System Command Handling ---
            if (data.type === 'system_command') {
                console.log('[Telegram Bridge] Received system command', data);
                if (data.command === 'reload_ui_only') {
                    console.log('[Telegram Bridge] Refreshing UI...');
                    setTimeout(reloadPage, 500);
                }
                return;
            }

            // --- Execute Command Handling ---
            if (data.type === 'execute_command') {
                console.log('[Telegram Bridge] Executing command', data);

                // Show "typing" status
                if (ws && ws.readyState === WebSocket.OPEN) {
                    ws.send(JSON.stringify({ type: 'typing_action', chatId: data.chatId }));
                }

                let replyText = 'Command execution failed, please try again later.';

                // Call global SillyTavern.getContext() directly
                const context = SillyTavern.getContext();
                let commandSuccess = false;

                try {
                    switch (data.command) {
                        case 'new':
                            await doNewChat({ deleteCurrentChat: false });
                            replyText = 'New chat has been started.';
                            commandSuccess = true;
                            break;
                        case 'listchars': {
                            const characters = context.characters.slice(1);
                            if (characters.length > 0) {
                                replyText = 'Available character list:\n\n';
                                characters.forEach((char, index) => {
                                    replyText += `${index + 1}. /switchchar_${index + 1} - ${char.name}\n`;
                                });
                                replyText += '\nUse /switchchar_number or /switchchar character_name to switch characters';
                            } else {
                                replyText = 'No available characters found.';
                            }
                            commandSuccess = true;
                            break;
                        }
                        case 'switchchar': {
                            if (!data.args || data.args.length === 0) {
                                replyText = 'Please provide character name or number. Usage: /switchchar <character_name> or /switchchar_number';
                                break;
                            }
                            const targetName = data.args.join(' ');
                            const characters = context.characters;
                            const targetChar = characters.find(c => c.name === targetName);

                            if (targetChar) {
                                const charIndex = characters.indexOf(targetChar);
                                await selectCharacterById(charIndex);
                                replyText = `Successfully switched to character "${targetName}".`;
                                commandSuccess = true;
                            } else {
                                replyText = `Character "${targetName}" not found.`;
                            }
                            break;
                        }
                        case 'listchats': {
                            if (context.characterId === undefined) {
                                replyText = 'Please select a character first.';
                                break;
                            }
                            const chatFiles = await getPastCharacterChats(context.characterId);
                            if (chatFiles.length > 0) {
                                replyText = 'Chat logs for current character:\n\n';
                                chatFiles.forEach((chat, index) => {
                                    const chatName = chat.file_name.replace('.jsonl', '');
                                    replyText += `${index + 1}. /switchchat_${index + 1} - ${chatName}\n`;
                                });
                                replyText += '\nUse /switchchat_number or /switchchat chat_name to switch chats';
                            } else {
                                replyText = 'Current character has no chat logs.';
                            }
                            commandSuccess = true;
                            break;
                        }
                        case 'switchchat': {
                            if (!data.args || data.args.length === 0) {
                                replyText = 'Please provide chat log name. Usage: /switchchat <chat_log_name>';
                                break;
                            }
                            const targetChatFile = `${data.args.join(' ')}`;
                            try {
                                await openCharacterChat(targetChatFile);
                                replyText = `Loaded chat log: ${targetChatFile}`;
                                commandSuccess = true;
                            } catch (err) {
                                console.error(err);
                                replyText = `Failed to load chat log "${targetChatFile}". Please confirm the name is completely correct.`;
                            }
                            break;
                        }
                        default: {
                            // Handle special format commands like switchchar_1, switchchat_2, etc.
                            const charMatch = data.command.match(/^switchchar_(\d+)$/);
                            if (charMatch) {
                                const index = parseInt(charMatch[1]) - 1;
                                const characters = context.characters.slice(1);
                                if (index >= 0 && index < characters.length) {
                                    const targetChar = characters[index];
                                    const charIndex = context.characters.indexOf(targetChar);
                                    await selectCharacterById(charIndex);
                                    replyText = `Switched to character "${targetChar.name}".`;
                                    commandSuccess = true;
                                } else {
                                    replyText = `Invalid character number: ${index + 1}. Please use /listchars to view available characters.`;
                                }
                                break;
                            }

                            const chatMatch = data.command.match(/^switchchat_(\d+)$/);
                            if (chatMatch) {
                                if (context.characterId === undefined) {
                                    replyText = 'Please select a character first.';
                                    break;
                                }
                                const index = parseInt(chatMatch[1]) - 1;
                                const chatFiles = await getPastCharacterChats(context.characterId);

                                if (index >= 0 && index < chatFiles.length) {
                                    const targetChat = chatFiles[index];
                                    const chatName = targetChat.file_name.replace('.jsonl', '');
                                    try {
                                        await openCharacterChat(chatName);
                                        replyText = `Loaded chat log: ${chatName}`;
                                        commandSuccess = true;
                                    } catch (err) {
                                        console.error(err);
                                        replyText = `Failed to load chat log.`;
                                    }
                                } else {
                                    replyText = `Invalid chat log number: ${index + 1}. Please use /listchats to view available chat logs.`;
                                }
                                break;
                            }

                            replyText = `Unknown command: /${data.command}. Use /help to view all commands.`;
                        }
                    }
                } catch (error) {
                    console.error('[Telegram Bridge] Error executing command:', error);
                    replyText = `Error executing command: ${error.message || 'Unknown error'}`;
                }

                // Send command execution result
                if (ws && ws.readyState === WebSocket.OPEN) {
                    // Send command execution result to Telegram
                    ws.send(JSON.stringify({ type: 'ai_reply', chatId: data.chatId, text: replyText }));

                    // Send command execution status feedback to server
                    ws.send(JSON.stringify({
                        type: 'command_executed',
                        command: data.command,
                        success: commandSuccess,
                        message: replyText
                    }));
                }

                return;
            }
        } catch (error) {
            console.error('[Telegram Bridge] Error processing request:', error);
            if (data && data.chatId && ws && ws.readyState === WebSocket.OPEN) {
                ws.send(JSON.stringify({ type: 'error_message', chatId: data.chatId, text: 'An internal error occurred while processing your request.' }));
            }
        }
    };

    ws.onclose = () => {
        console.log('[Telegram Bridge] Connection closed.');
        updateStatus('Disconnected', 'red');
        ws = null;
    };

    ws.onerror = (error) => {
        console.error('[Telegram Bridge] WebSocket error:', error);
        updateStatus('Connection error', 'red');
        ws = null;
    };
}

function disconnect() {
    if (ws) {
        ws.close();
    }
}

// Function executed when extension loads
jQuery(async () => {
    console.log('[Telegram Bridge] Attempting to load settings UI...');
    try {
        const settingsHtml = await $.get(`/scripts/extensions/third-party/${MODULE_NAME}/settings.html`);
        $('#extensions_settings').append(settingsHtml);
        console.log('[Telegram Bridge] Settings UI should have been added.');

        const settings = getSettings();
        $('#telegram_bridge_url').val(settings.bridgeUrl);
        $('#telegram_auto_connect').prop('checked', settings.autoConnect);

        $('#telegram_bridge_url').on('input', () => {
            const settings = getSettings();
            settings.bridgeUrl = $('#telegram_bridge_url').val();
            // Ensure saveSettingsDebounced is called to save settings
            saveSettingsDebounced();
        });

        $('#telegram_auto_connect').on('change', function () {
            const settings = getSettings();
            settings.autoConnect = $(this).prop('checked');
            // Ensure saveSettingsDebounced is called to save settings
            console.log(`[Telegram Bridge] Auto-connect setting changed to: ${settings.autoConnect}`);
            saveSettingsDebounced();
        });

        $('#telegram_connect_button').on('click', connect);
        $('#telegram_disconnect_button').on('click', disconnect);

        if (settings.autoConnect) {
            console.log('[Telegram Bridge] Auto-connect enabled, connecting...');
            connect();
        }

    } catch (error) {
        console.error('[Telegram Bridge] Failed to load settings HTML.', error);
    }
    console.log('[Telegram Bridge] Extension loaded.');
});

// Global event listener for final message update
function handleFinalMessage(lastMessageIdInChatArray) {
    // Ensure WebSocket is connected and we have a valid chatId to send updates
    if (!ws || ws.readyState !== WebSocket.OPEN || !lastProcessedChatId) {
        return;
    }

    const lastMessageIndex = lastMessageIdInChatArray - 1;
    if (lastMessageIndex < 0) return;

    // Delay to ensure DOM update is complete
    setTimeout(() => {
        // Call global SillyTavern.getContext() directly
        const context = SillyTavern.getContext();
        const lastMessage = context.chat[lastMessageIndex];

        // Confirm this is the AI reply we just triggered via Telegram
        if (lastMessage && !lastMessage.is_user && !lastMessage.is_system) {
            const messageElement = $(`#chat .mes[mesid="${lastMessageIndex}"]`);

            if (messageElement.length > 0) {
                // Get message text element
                const messageTextElement = messageElement.find('.mes_text');

                // Get HTML content and replace <br> and </p><p> with newlines
                let renderedText = messageTextElement.html()
                    .replace(/<br\s*\/?>/gi, '\n')
                    .replace(/<\/p>\s*<p>/gi, '\n\n')
                // .replace(/<[^>]*>/g, ''); // Remove all other HTML tags

                // Decode HTML entities
                const tempDiv = document.createElement('div');
                tempDiv.innerHTML = renderedText;
                renderedText = tempDiv.textContent;

                console.log(`[Telegram Bridge] Captured final rendered text, preparing to send update to chatId: ${lastProcessedChatId}`);

                // Determine if streaming or non-streaming response
                if (isStreamingMode) {
                    // Streaming response - send final_message_update
                    ws.send(JSON.stringify({
                        type: 'final_message_update',
                        chatId: lastProcessedChatId,
                        text: renderedText,
                    }));
                    // Reset streaming mode flag
                    isStreamingMode = false;
                } else {
                    // Non-streaming response - send ai_reply directly
                    ws.send(JSON.stringify({
                        type: 'ai_reply',
                        chatId: lastProcessedChatId,
                        text: renderedText,
                    }));
                }

                // Reset chatId to avoid accidentally updating other users' messages
                lastProcessedChatId = null;
            }
        }
    }, 100);
}

// Global event listener for final message update
eventSource.on(event_types.GENERATION_ENDED, handleFinalMessage);

// Handle manual generation stop
eventSource.on(event_types.GENERATION_STOPPED, handleFinalMessage);