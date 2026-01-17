## About This Project
I apologize, but due to increasing work and life commitments, I may not be able to continue maintaining this project.  
The project code is completely open source, and anyone is welcome to fork it and develop their own improvements.  
If you are interested in this project, feel free to use it as a starting point for your own project without needing additional permission.  
Thank you for your understanding and support.

# SillyTavern Telegram Connector

SillyTavern Telegram Connector is an extension designed for SillyTavern that allows users to interact with AI characters in SillyTavern through Telegram. This extension creates a bridge between SillyTavern and Telegram bots, enabling users to chat with their favorite AI characters anytime, anywhere on their mobile devices.

[![License](https://img.shields.io/github/license/qiqi20020612/SillyTavern-Telegram-Connector)](https://github.com/qiqi20020612/SillyTavern-Telegram-Connector/blob/main/LICENSE)
[![stars](https://img.shields.io/github/stars/qiqi20020612/SillyTavern-Telegram-Connector)](https://github.com/qiqi20020612/SillyTavern-Telegram-Connector)

## Features

- **Bot-per-Character Architecture**: Each Telegram bot is dedicated to a specific SillyTavern character
- **Multiple Characters**: Run multiple bots simultaneously, each representing a different AI character
- **Real-time Sync**: Conversations in Telegram sync in real-time to the SillyTavern interface
- **Streaming Responses**: See AI responses stream in real-time as they're generated
- **FIFO Queue System**: Requests are serialized to prevent race conditions in the single-threaded SillyTavern
- **Command Support**: Manage chats directly from Telegram
  - `/help` - Show all available commands
  - `/new` - Start a new chat with the current character
  - `/listchats` - List all chat logs for the current character
  - `/switchchat <name>` - Switch to a specific chat log
  - `/ping` - Check connection status

## Architecture

```
User A ──► Bot "Serana"  ──┐
                          ├──► Node.js Server ──► WebSocket ──► SillyTavern
User B ──► Bot "Garrus"  ──┘    (FIFO Queue)
```

Each bot automatically switches SillyTavern to its configured character before processing messages.

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
   ```bash
   npm install
   ```
4. Copy the configuration template:
   ```bash
   cp config.example.js config.js
   ```
5. Edit `config.js` to configure your bots:
   ```javascript
   module.exports = {
       wssPort: 2333,
       allowedUserIds: [123456789], // Your Telegram user ID (get from @userinfobot)
       
       // Behavior Configuration (Optional)
       behavior: {
           debounceSeconds: 10, // Wait time for message batching
           userMessageFormat: '<div class="timestamp">[{{date}}]</div> ', // Timestamp format
           botMessageFilterRegex: '^<div class="timestamp">.*?<\\/div>\\s*' // Strip timestamp from bot reply
       },
       
       bots: [
           {
               token: 'BOT_TOKEN_FROM_BOTFATHER',
               characterName: 'Serana'  // Exact character name in SillyTavern
           },
           {
               token: 'ANOTHER_BOT_TOKEN',
               characterName: 'Garrus'
           }
       ]
   };
   ```
6. Start the server:
   ```bash
   node server.js
   ```

### Creating Telegram Bots

1. Open Telegram and search for [@BotFather](https://t.me/BotFather)
2. Send `/newbot` and follow the prompts to create a bot
3. Copy the token provided and add it to your `config.js`
4. Repeat for each character you want to expose via Telegram

### Connection Configuration

1. In SillyTavern, go to the "Extensions" tab
2. Find the "Telegram Connector" section
3. Enter the WebSocket server address (default: `ws://127.0.0.1:2333`)
4. Click the "Connect" button
5. Status should show "Connected"

### Using Telegram

1. In Telegram, start a conversation with one of your configured bots
2. Send any message to start chatting
3. The server will automatically switch to the correct character and generate a response
4. Use `/help` to see available commands

## System Requirements

- Node.js 18.0 or higher
- Running SillyTavern instance
- Internet connection (for Telegram API)
- One Telegram bot per character you want to use

## How It Works

1. You send a message to Bot A (configured for "Serana")
2. The server enqueues your request
3. When your turn comes, the server:
   - Switches SillyTavern to "Serana" (if not already)
   - Waits for confirmation
   - Sends your message for generation
   - Streams the response back to Bot A
4. The mutex is released, and the next queued request is processed

This ensures that even with multiple bots and users, responses always go to the correct character.

## Troubleshooting

- **"Character not found"**: Ensure `characterName` in config.js exactly matches the character name in SillyTavern
- **"SillyTavern not connected"**: Check that SillyTavern is open and the extension shows "Connected"
- **Long wait times**: Multiple requests are processed sequentially; check `/ping` for queue status
- **Bot not responding**: Verify the bot token is correct and the server is running

## Support and Contributions

If you encounter problems or have suggestions for improvements:

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
  - [x] Move command processing to server
  - [x] Bot-per-Character architecture with FIFO queue
  - [ ] Convert server to standard SillyTavern server plugin

- **User Experience Improvements**:
  - [x] Adjust message editing frequency
  - [x] Streaming optimization
  - [ ] "Typing" status persists throughout streaming
  - [x] Add `/ping` command for status checks

- **Settings Menu**:
  - [ ] Add whitelist settings to extension settings page
  - [ ] Control notification behavior

- **Error Handling and Stability**:
  - [x] Handle "Stop Generation" button click
  - [x] Mutex-based request serialization
  - [x] Character switch confirmation before generation
  - [ ] WebSocket heartbeat for connection health

- **Technical Optimizations**:
  - [ ] Implement WebSocket heartbeat
  - [ ] Optimize DOM update waiting
