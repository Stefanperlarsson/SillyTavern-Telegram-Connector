# Telegram Bridge Server

This is the server-side component of SillyTavern Telegram Connector. It implements a **Bot-per-Character** architecture where each Telegram bot represents a dedicated SillyTavern character.

## Architecture Overview

```
[Telegram Cloud]
       ^
       | (Multiple Bot Tokens)
       v
[Node.js Process (server.js)]
   |-- BotManager (Manages multiple bot instances)
   |-- RequestQueue (FIFO queue with mutex)
   |-- WebSocket Server
       ^
       | (Single persistent connection)
       v
[Web Browser (SillyTavern Tab)]
   |-- index.js (Extension)
```

### Key Features

- **Multiple Bots**: Each bot is dedicated to a specific SillyTavern character
- **FIFO Queue**: All requests are serialized to prevent race conditions
- **Mutex Lock**: Ensures character switches complete before message generation
- **Automatic Character Switching**: The server automatically switches to the correct character based on which bot received the message

## Installation

### Prerequisites

- Node.js 18.0 or higher
- One or more Telegram bots created via [@BotFather](https://t.me/BotFather)

### Installation Steps

1. Install dependencies:
   ```bash
   cd server
   npm install
   ```

2. Configuration:
   ```bash
   cp config.example.js config.js
   ```

3. Edit `config.js` to configure your bots:
   ```javascript
   module.exports = {
       wssPort: 2333,
       allowedUserIds: [123456789], // Your Telegram user ID
       bots: [
           {
               token: 'YOUR_FIRST_BOT_TOKEN',
               characterName: 'Serana'  // Exact ST character name
           },
           {
               token: 'YOUR_SECOND_BOT_TOKEN',
               characterName: 'Garrus'
           }
       ]
   };
   ```

4. Start the server:
   ```bash
   node server.js
   ```

## Configuration

### `config.js` Options

| Option | Type | Description |
|--------|------|-------------|
| `wssPort` | number | WebSocket server port (default: 2333) |
| `allowedUserIds` | number[] | Telegram user IDs allowed to use the bots. Empty array `[]` allows all users. |
| `bots` | BotConfig[] | Array of bot configurations |

### Bot Configuration

Each bot in the `bots` array requires:

| Field | Type | Description |
|-------|------|-------------|
| `token` | string | Telegram Bot API token from @BotFather |
| `characterName` | string | **Exact** name of the SillyTavern character this bot represents |

**Important**: The `characterName` must exactly match the character's name in SillyTavern (case-sensitive by default, with case-insensitive fallback).

## How It Works

### Request Flow

1. User sends message to Bot A (configured for character "Serana")
2. Server enqueues the request: `{ bot: A, text: "Hello", targetChar: "Serana" }`
3. Server acquires mutex lock
4. Server sends `switchchar` command to SillyTavern extension
5. Extension confirms character switch succeeded
6. Server sends user message for generation
7. Extension streams response tokens back
8. Server routes tokens to Bot A and updates the Telegram message
9. On completion, server releases mutex and processes next queued request

### Why a Queue?

SillyTavern is a single-threaded, stateful application. Without serialization:
- Bot A could switch to Serana
- Bot B switches to Garrus mid-generation
- Bot A's response goes to the wrong character

The FIFO queue with mutex ensures complete isolation between requests.

## Available Commands

Commands available in each bot:

| Command | Description |
|---------|-------------|
| `/help` | Show available commands |
| `/new` | Start a new chat with this character |
| `/listchats` | List saved chat logs for this character |
| `/switchchat <name>` | Load a specific chat log |
| `/switchchat_<N>` | Load chat log by number |
| `/ping` | Check connection status |
| `/reload` | Reload server configuration |
| `/restart` | Restart the server |
| `/exit` | Shutdown the server |

**Note**: Unlike the single-bot architecture, `/listchars` and `/switchchar` are not available since each bot is dedicated to one character.

## Troubleshooting

### "Character not found" Error

- Verify the `characterName` in config.js exactly matches the character name in SillyTavern
- Character names are case-sensitive (case-insensitive fallback is available)

### "SillyTavern not connected" Error

- Ensure SillyTavern is open in a browser tab
- Check that the Telegram Connector extension is enabled
- Verify the extension is connected (green status indicator)

### Queue Stuck

If requests seem to hang:
- Check SillyTavern browser console for errors
- The server has a 30-second timeout for character switches
- Use `/ping` to check connection status

### Port Already in Use

```bash
# Find process using port 2333
lsof -i :2333  # macOS/Linux
netstat -ano | findstr :2333  # Windows

# Change port in config.js
wssPort: 2334
```

## Security Notes

- **Never share your config.js** - it contains your bot tokens
- Use `allowedUserIds` to restrict access to authorized users only
- If exposing the WebSocket server publicly, use a reverse proxy with SSL/TLS
- The config.js file is already in .gitignore

## Docker Support

```bash
# Build
docker build -t st-telegram-bridge .

# Run
docker run -d \
  -p 2333:2333 \
  -v $(pwd)/config.js:/app/config.js \
  st-telegram-bridge
```

Or with docker-compose:

```bash
docker-compose up -d
```

## Developer Notes

### Key Files

- `server.js` - Main server with BotManager, RequestQueue, and WebSocket handling
- `config.js` - User configuration (not in git)
- `config.example.js` - Configuration template

### Adding Features

The server uses JSDoc annotations for type documentation. Key types:
- `BotConfig` - Bot configuration from config.js
- `ManagedBot` - Runtime bot instance with metadata
- `QueueJob` - Request in the FIFO queue
- `StreamSession` - Active streaming response state
- `ActiveJob` - Currently processing job with mutex state
