# Telegram Bridge Server

This is the server-side component of SillyTavern Telegram Connector, responsible for establishing a communication bridge between the Telegram bot and the SillyTavern extension.

## Features

- Receive messages from Telegram users and forward them to SillyTavern
- Receive AI replies from SillyTavern and forward them back to Telegram
- Handle special commands such as character switching, chat management, etc.
- Maintain WebSocket connection status

## Installation

### Prerequisites

- Node.js 14.0 or higher
- Created Telegram bot and Bot Token

### Installation Steps

1. Install dependencies:
   ```bash
   npm install node-telegram-bot-api ws
   ```

2. Configuration:
   - Copy the `config.example.js` file to `config.js`:
   ```bash
   # Linux/macOS
   cp ../config.example.js ../config.js
   
   # Windows
   copy ..\config.example.js ..\config.js
   ```
   - Edit the `config.js` file and replace `telegramToken` with your Telegram Bot Token
   - To change the default port (2333), modify the `wssPort` parameter

3. Start the server:
   ```bash
   node server.js
   ```

## Usage Instructions

After the server starts, the following information will be displayed in the console:
- `Telegram Bot started...`
- `WebSocket server listening on port XXXX...`

When the SillyTavern extension connects to the server, it will display:
- `SillyTavern extension connected!`

### Security Notes

- By default, the server only accepts local connections. If you need remote access, consider the following security measures:
  - Use HTTPS/WSS encrypted connections
  - Implement appropriate authentication mechanisms
  - Restrict IP access
  - Ensure the `config.js` file is not publicly shared (already set in .gitignore)

- Do not publicly share code containing your Bot Token

## Troubleshooting

- **Cannot start server**: Check if the port is already in use and if Node.js is installed correctly
- **Configuration file not found**: Ensure you have copied `config.example.js` to `config.js` and placed it in the correct location
- **Telegram Bot not responding**: Verify that the Bot Token is correct and check the Telegram API connection status
- **WebSocket connection failed**: Ensure the firewall is not blocking the specified port and check network configuration

## Developer Information

To modify or extend server functionality, the main file is `server.js`, which contains:
- WebSocket server setup
- Telegram Bot initialization and message handling
- Command parsing and processing logic

Configuration information is now stored in the `config.js` file in the project root directory, including:
- Telegram Bot Token
- WebSocket server port