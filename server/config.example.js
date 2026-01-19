// config.example.js
// Telegram Bot configuration example
// Usage: Copy this file to config.js, then modify the configuration below

module.exports = {
    // WebSocket server port
    wssPort: 2333,

    // Whitelist of Telegram user IDs allowed to interact with the bots
    // Add your own Telegram User ID (and IDs of other users you want to allow) to an array.
    // You can get your ID by chatting with @userinfobot on Telegram.
    // If you leave an empty array `[]`, all users will be allowed to access.
    // Example: [123456789, 987654321]
    allowedUserIds: [],

    // Behavior Configuration
    behavior: {
        // Time in seconds to wait after the last message before processing the stack (Debounce)
        debounceSeconds: 10,

        // Template for the timestamp prepended to user messages
        // {{date}} will be replaced by the message timestamp (YYYY-MM-DD HH:mm:ss)
        // Set to null or empty string to disable
        userMessageFormat: '<div class="timestamp">[{{date}}]</div> ',
        
        // Regex used to identify and strip the timestamp from the bot's response
        // NOTE: This matches the RENDERED text (after HTML is processed), not raw HTML
        // The default matches timestamps like [2026-01-17 18:23:31] at the start of lines
        botMessageFilterRegex: '^\\[\\d{4}-\\d{2}-\\d{2} \\d{2}:\\d{2}:\\d{2}\\]\\s*',
        
        // Character used to split bot responses into multiple Telegram messages
        // Set to null or empty string to disable splitting (send as single message)
        messageSplitChar: '\n'
    },

    // Summarization Configuration
    // Used by /summarize and /set_summary commands for conversation archival
    summarization: {
        // System prompt for generating conversation summaries
        // This prompt instructs the LLM how to summarize the conversation
        summarizationPrompt: `You are a memory archivist. Your task is to create a concise summary of the conversation that just occurred between {{user}} and {{char}}.

Focus on:
- Key events and decisions made
- Important information revealed about characters
- Emotional moments or relationship developments
- Any promises, plans, or commitments made

Format the summary as a narrative paragraph, written in past tense from a third-person perspective. Keep it under 300 words.

Do not include meta-commentary about the conversation itself. Write as if documenting events that actually happened.`,

        // World Info / Lorebook settings for storing summaries
        // The summary will be appended to an existing entry in this lorebook
        lorebookName: 'Character Memories',  // Name of the World Info book to use
        entryName: 'Past Events',            // Name of the entry to append summaries to
    },

    // Bot-per-Character Configuration
    // Each bot in this array represents a dedicated Telegram bot for a specific SillyTavern character.
    // The server will automatically switch to the correct character before processing messages.
    bots: [
        {
            // Telegram Bot Token (get from @BotFather)
            token: 'YOUR_FIRST_BOT_TOKEN_HERE',
            // Exact name of the SillyTavern character this bot represents
            characterName: 'Character Name Here',
            // Optional: Name of the Connection Profile to use for this character
            // This allows you to use different backends/models for different characters.
            // The profile must exist in SillyTavern.
            // connectionProfile: 'My GPT-4 Profile'
        },
        // Add more bots as needed:
        // {
        //     token: 'YOUR_SECOND_BOT_TOKEN_HERE',
        //     characterName: 'Another Character'
        // }
    ]
};
