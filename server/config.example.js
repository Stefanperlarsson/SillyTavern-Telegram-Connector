// config.example.js
// Telegram Bot configuration example
// Usage: Copy this file to config.js, then modify the configuration below

module.exports = {
    // Replace with your own Telegram Bot Token
    telegramToken: 'YOUR_TELEGRAM_BOT_TOKEN_HERE',

    // WebSocket server port
    wssPort: 2333,

    // Whitelist of Telegram user IDs allowed to interact with the bot
    // Add your own Telegram User ID (and IDs of other users you want to allow) to an array.
    // You can get your ID by chatting with @userinfobot on Telegram.
    // If you leave an empty array `[]`, all users will be allowed to access.
    // Example: [123456789, 987654321]
    allowedUserIds: []
};