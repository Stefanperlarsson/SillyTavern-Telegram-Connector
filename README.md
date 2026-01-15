## About This Project
I apologize, but due to increasing work and life commitments, I may not be able to continue maintaining this project.  
The project code is completely open source, and anyone is welcome to fork it and develop their own improvements.  
If you are interested in this project, feel free to use it as a starting point for your own project without needing additional permission.  
Thank you for your understanding and support.

# SillyTavern Telegram Connector

SillyTavern Telegram Connector is an extension designed for SillyTavern that allows users to interact with AI characters in SillyTavern through Telegram. This extension creates a bridge between SillyTavern and a Telegram bot, enabling users to chat with their favorite AI characters anytime, anywhere on their mobile devices.  
[![License](https://img.shields.io/github/license/qiqi20020612/SillyTavern-Telegram-Connector)](https://github.com/qiqi20020612/SillyTavern-Telegram-Connector/blob/main/LICENSE)
[![stars](https://img.shields.io/github/stars/qiqi20020612/SillyTavern-Telegram-Connector)](https://github.com/qiqi20020612/SillyTavern-Telegram-Connector)

## Features

- **Telegram Integration**: Chat with AI characters in SillyTavern through the Telegram app
- **Real-time Sync**: Conversations in Telegram sync in real-time to the SillyTavern interface, and vice versa
- **Command Support**: Provides various Telegram commands for managing chats and characters
  - `/help` - Show all available commands
  - `/new` - Start a new chat
  - `/listchars` - List all available characters
  - `/switchchar <character name>` - Switch to specified character
  - `/listchats` - List all chat logs for the current character
  - `/switchchat <chat name>` - Switch to specified chat log
- **Simple Configuration**: Easy to set up and use via WebSocket connection

## Installation and Usage

### Extension Installation

1. In SillyTavern, navigate to the "Extensions" tab
2. Click "Install Extension"
3. Enter the following URL: `https://github.com/qiqi20020612/SillyTavern-Telegram-Connector`
4. Click the "Install" button
5. After installation is complete, restart SillyTavern

### Server Setup

1. Clone or download this repository to your computer
2. Navigate to the `server` directory
3. Install dependencies:
   ```
   npm install node-telegram-bot-api ws
   ```
4. Copy the `config.example.js` file to `config.js`:
   ```
   cp config.example.js config.js
   ```
   Or on Windows:
   ```
   copy config.example.js config.js
   ```
5. Edit the `config.js` file and replace `YOUR_TELEGRAM_BOT_TOKEN_HERE` with your Telegram Bot Token
   (You can obtain it from [@BotFather](https://t.me/BotFather) on Telegram)
6. Start the server:
   ```
   node server.js
   ```

### Connection Configuration

1. In SillyTavern, go to the "Extensions" tab
2. Find the "Telegram Connector" section
3. Enter the WebSocket server address in the "Bridge Server WebSocket URL" field
   (Default is `ws://127.0.0.1:2333`)
4. Click the "Connect" button
5. Once the status shows "Connected", you can start using it

### Using Telegram

1. In Telegram, search for and start a conversation with the bot you created
2. Send any message to start chatting
3. Your messages will be sent to SillyTavern, and the AI's replies will automatically be sent back to Telegram
4. Use the `/help` command to view all available commands

## System Requirements

- Node.js 14.0 or higher
- Running SillyTavern instance
- Internet connection (for Telegram API)
- If the server is publicly accessible, it is recommended to use HTTPS/WSS

## Troubleshooting

- **Connection Issues**: Ensure the WebSocket server is running and the URL is configured correctly
- **Bot Not Responding**: Check that the Telegram Bot Token is correct and review the server logs for errors
- **Messages Not Syncing**: Ensure the SillyTavern extension is connected to the WebSocket server

## Support and Contributions

If you encounter problems or have suggestions for improvements, please contact via:

- Create a GitHub Issue
- Contact the author: ZMou
- Visit the author's homepage: https://zmoutech.cn

Pull Requests to improve this extension are welcome!

## License

This project is licensed under the GNU General Public License v3.0 (GPL-3.0) - see the LICENSE file for details

## TODO

- **Group Chat Features**:
  - [ ] Respond to @bot mentions in group chats

- **Media Support**:
  - [ ] Support for sending images

- **Message Formatting**:
  - [ ] Implement markdown escaping
  - [ ] Change bot message parsing to HTML format

- **Architecture Improvements**:
  - [x] Move command processing to server, frontend no longer participates in command parsing
  - [ ] Convert server to standard server-side plugin following [SillyTavern server plugin specification](https://docs.sillytavern.app/for-contributors/server-plugins/)

- **User Experience Improvements**:
  - [x] Adjust message editing frequency
  - [x] Streaming optimization: display initial message only after generating sufficient text
  - [ ] "Typing" status persists throughout the entire streaming response
  - [x] Add `/ping` command for users to check Bridge connection status and SillyTavern status

- **Settings Menu**:
  - [ ] Add whitelist settings to extension settings page
  - [ ] Control whether to send Telegram notifications during webpage activities like character switching

- **Error Handling and Stability**:
  - [ ] `/exit` command always shows "Exit operation timeout, forcing process exit"
  - [x] Handle "Stop Generation" button click event in ST (GENERATION_STOPPED instead of GENERATION_ENDED)
  - [ ] Handle sending new message while generation is in progress (intercept and notify user, don't submit to ST)
  - [ ] Notify server to clear old cached state after `/switchchar` or `/switchchat` commands

- **Technical Optimizations**:
  - [ ] Implement WebSocket heartbeat to detect browser liveness
  - [ ] Optimize setTimeout for waiting on DOM updates