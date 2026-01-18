module.exports = {
    COMMANDS: {
        RESTART: 'restart',
        RELOAD: 'reload',
        EXIT: 'exit',
        PING: 'ping',
        HELP: 'help',
        NEW_CHAT: 'new',
        LIST_CHATS: 'listchats',
        DELETE_MESSAGES: 'delete',
        TRIGGER_GENERATION: 'trigger',
        SWITCH_MODEL: 'switchmodel'
    },
    EVENTS: {
        STREAM_CHUNK: 'stream_chunk',
        STREAM_END: 'stream_end',
        FINAL_MESSAGE: 'final_message_update',
        AI_REPLY: 'ai_reply',
        ERROR: 'error_message',
        TYPING: 'typing_action',
        CHAT_ACTION: 'chat_action',
        COMMAND_EXECUTED: 'command_executed',
        EXECUTE_COMMAND: 'execute_command',
        USER_MESSAGE: 'user_message'
    }
};
