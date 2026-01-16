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

    // Bot-per-Character Configuration
    // Each bot in this array represents a dedicated Telegram bot for a specific SillyTavern character.
    // The server will automatically switch to the correct character before processing messages.
    bots: [
        {
            // Telegram Bot Token (get from @BotFather)
            token: 'YOUR_FIRST_BOT_TOKEN_HERE',
            // Exact name of the SillyTavern character this bot represents
            characterName: 'Character Name Here'
        },
        // Add more bots as needed:
        // {
        //     token: 'YOUR_SECOND_BOT_TOKEN_HERE',
        //     characterName: 'Another Character'
        // }
    ]
};
