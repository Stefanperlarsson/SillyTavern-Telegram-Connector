/**
 * @fileoverview Queue Manager singleton for FIFO job processing with mutex.
 * Handles message batching, debouncing, and serialized job execution.
 * @module services/queueManager
 */

const Logger = require('../utils/logger');
const { JOB_TYPES, DEFAULTS } = require('../constants/system');

/**
 * @typedef {import('../types/index').QueueJob} QueueJob
 * @typedef {import('../types/index').ActiveJob} ActiveJob
 * @typedef {import('../types/index').ManagedBot} ManagedBot
 * @typedef {import('../types/index').FileAttachment} FileAttachment
 */

/**
 * Message buffer entry for debouncing.
 * @typedef {Object} MessageBuffer
 * @property {NodeJS.Timeout} timer - Debounce timer.
 * @property {Array<{text: string, files: FileAttachment[]}>} messages - Buffered messages.
 * @property {ManagedBot} managedBot - Bot handling these messages.
 * @property {number} chatId - Chat ID.
 * @property {number} userId - User ID.
 * @property {string} targetCharacter - Target character name.
 */

/**
 * Callback type for job processor.
 * @callback JobProcessor
 * @param {QueueJob} job - The job to process.
 * @returns {Promise<void>}
 */

/**
 * Callback type for connection check.
 * @callback ConnectionChecker
 * @returns {boolean}
 */

/**
 * Callback type for disconnect notification.
 * @callback DisconnectNotifier
 * @param {QueueJob} job - The job to notify about.
 * @param {string} message - Notification message.
 * @returns {Promise<void>}
 */

/**
 * Singleton Queue Manager for serialized job processing.
 * @class
 */
class QueueManager {
    /**
     * Singleton instance.
     * @type {QueueManager|null}
     * @private
     */
    static _instance = null;

    /**
     * Gets the singleton instance.
     * @returns {QueueManager}
     */
    static getInstance() {
        if (!QueueManager._instance) {
            QueueManager._instance = new QueueManager();
        }
        return QueueManager._instance;
    }

    /**
     * Creates a new QueueManager instance.
     * @private
     */
    constructor() {
        /** @type {QueueJob[]} */
        this._queue = [];

        /** @type {ActiveJob|null} */
        this._activeJob = null;

        /** @type {boolean} */
        this._isProcessing = false;

        /** @type {Map<string, MessageBuffer>} */
        this._messageBuffers = new Map();

        /** @type {number} */
        this._debounceMilliseconds = DEFAULTS.DEBOUNCE_SECONDS * 1000;

        /** @type {JobProcessor|null} */
        this._jobProcessor = null;

        /** @type {ConnectionChecker|null} */
        this._connectionChecker = null;

        /** @type {DisconnectNotifier|null} */
        this._disconnectNotifier = null;

        /** @type {Function|null} */
        this._onJobReleased = null;
    }

    /**
     * Configures the queue manager.
     * @param {Object} options - Configuration options.
     * @param {number} [options.debounceSeconds] - Debounce time in seconds.
     * @param {JobProcessor} [options.jobProcessor] - Function to process jobs.
     * @param {ConnectionChecker} [options.connectionChecker] - Function to check connection.
     * @param {DisconnectNotifier} [options.disconnectNotifier] - Function to notify on disconnect.
     * @param {Function} [options.onJobReleased] - Callback when job is released.
     */
    configure(options) {
        if (options.debounceSeconds !== undefined) {
            this._debounceMilliseconds = options.debounceSeconds * 1000;
        }
        if (options.jobProcessor) {
            this._jobProcessor = options.jobProcessor;
        }
        if (options.connectionChecker) {
            this._connectionChecker = options.connectionChecker;
        }
        if (options.disconnectNotifier) {
            this._disconnectNotifier = options.disconnectNotifier;
        }
        if (options.onJobReleased) {
            this._onJobReleased = options.onJobReleased;
        }
    }

    /**
     * Generates a unique job ID.
     * @returns {string} Unique identifier.
     * @private
     */
    _generateJobId() {
        return `job_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
    }

    /**
     * Gets the current queue length.
     * @returns {number} Number of jobs in queue.
     */
    getQueueLength() {
        return this._queue.length;
    }

    /**
     * Gets the active job.
     * @returns {ActiveJob|null} The currently processing job.
     */
    getActiveJob() {
        return this._activeJob;
    }

    /**
     * Checks if currently processing a job.
     * @returns {boolean} True if processing.
     */
    isProcessing() {
        return this._isProcessing;
    }

    /**
     * Gets a unique buffer key for a chat and bot combination.
     * @param {string} botId - Bot identifier.
     * @param {number} chatId - Telegram chat ID.
     * @returns {string} Buffer key.
     * @private
     */
    _getBufferKey(botId, chatId) {
        return `${botId}_${chatId}`;
    }

    /**
     * Adds a message to the debounce buffer.
     * @param {ManagedBot} managedBot - The bot receiving the message.
     * @param {number} chatId - Telegram chat ID.
     * @param {number} userId - Telegram user ID.
     * @param {string} text - Message text.
     * @param {FileAttachment[]} [files] - File attachments.
     */
    debounceMessage(managedBot, chatId, userId, text, files) {
        const bufferKey = this._getBufferKey(managedBot.id, chatId);
        let buffer = this._messageBuffers.get(bufferKey);

        if (buffer) {
            clearTimeout(buffer.timer);
        } else {
            buffer = {
                messages: [],
                managedBot: managedBot,
                chatId: chatId,
                userId: userId,
                targetCharacter: managedBot.characterName,
            };
            this._messageBuffers.set(bufferKey, buffer);
        }

        if (text || (files && files.length > 0)) {
            buffer.messages.push({
                text: text,
                files: files,
            });
            Logger.debug(`Buffered message for bot ${managedBot.id} chat ${chatId} (buffer size: ${buffer.messages.length})`);
        }

        buffer.timer = setTimeout(() => {
            this._flushMessageBuffer(bufferKey);
        }, this._debounceMilliseconds);
    }

    /**
     * Flushes the message buffer for a chat, creating a single batch job.
     * @param {string} bufferKey - The buffer key to flush.
     * @private
     */
    _flushMessageBuffer(bufferKey) {
        const buffer = this._messageBuffers.get(bufferKey);
        if (!buffer) {
            return;
        }

        this._messageBuffers.delete(bufferKey);

        if (buffer.messages.length === 0) {
            return;
        }

        Logger.info(`Flushing buffer for bot ${buffer.managedBot.characterName} (${buffer.managedBot.id}) chat ${buffer.chatId} with ${buffer.messages.length} message(s)`);

        const lastMessage = buffer.messages[buffer.messages.length - 1];

        /** @type {QueueJob} */
        const job = {
            id: '',
            managedBot: buffer.managedBot,
            chatId: buffer.chatId,
            userId: buffer.userId,
            text: lastMessage.text || '(Batch Request)',
            targetCharacter: buffer.targetCharacter,
            type: JOB_TYPES.MESSAGE,
            messages: buffer.messages,
            files: undefined,
            timestamp: 0,
        };

        this.enqueueJob(job);
    }

    /**
     * Adds a job to the queue and triggers processing.
     * @param {QueueJob} job - The job to enqueue.
     */
    enqueueJob(job) {
        job.id = this._generateJobId();
        job.timestamp = Date.now();
        this._queue.push(job);
        Logger.info(`Job ${job.id} enqueued for character "${job.targetCharacter}" (queue size: ${this._queue.length})`);
        this._processNext();
    }

    /**
     * Processes the next job in the queue if not already processing.
     * Implements the mutex lock pattern.
     * @private
     */
    async _processNext() {
        // Mutex check - if already processing, exit
        if (this._isProcessing) {
            return;
        }

        // Check if there are jobs to process
        if (this._queue.length === 0) {
            return;
        }

        // Check if SillyTavern is connected
        if (this._connectionChecker && !this._connectionChecker()) {
            Logger.warn('Cannot process queue: SillyTavern not connected');
            // Notify all queued users
            for (const job of this._queue) {
                if (this._disconnectNotifier) {
                    await this._disconnectNotifier(
                        job,
                        'Sorry, I cannot connect to SillyTavern right now. Please ensure SillyTavern is open and the Telegram extension is enabled.'
                    );
                }
            }
            this._queue.length = 0; // Clear queue
            return;
        }

        // Acquire lock
        this._isProcessing = true;

        // Dequeue the next job
        const job = this._queue.shift();
        this._activeJob = {
            job: job,
            characterSwitched: false,
            abortController: null,
            switchResolve: null,
            switchReject: null,
        };

        Logger.info(`Processing job ${job.id} for bot "${job.targetCharacter}"`);

        try {
            if (this._jobProcessor) {
                await this._jobProcessor(job);
            }
        } catch (error) {
            Logger.error(`Error processing job ${job.id}:`, error.message);
            if (this._disconnectNotifier) {
                await this._disconnectNotifier(job, `An error occurred: ${error.message}`);
            }
            this.releaseJob();
        }
    }

    /**
     * Sets the character switched flag and resolves pending switch promise.
     */
    confirmCharacterSwitch() {
        if (!this._activeJob) {
            return;
        }
        this._activeJob.characterSwitched = true;
        if (this._activeJob.switchResolve) {
            this._activeJob.switchResolve();
        }
    }

    /**
     * Rejects a pending switch promise with an error.
     * @param {Error} error - The error to reject with.
     */
    rejectCharacterSwitch(error) {
        if (!this._activeJob || !this._activeJob.switchReject) {
            return;
        }
        this._activeJob.switchReject(error);
    }

    /**
     * Creates a promise that resolves when character switch is confirmed.
     * @param {number} [timeoutMilliseconds=30000] - Timeout in milliseconds.
     * @returns {Promise<void>}
     */
    waitForCharacterSwitch(timeoutMilliseconds = 30000) {
        return new Promise((resolve, reject) => {
            if (!this._activeJob) {
                reject(new Error('No active job'));
                return;
            }

            const timeout = setTimeout(() => {
                reject(new Error('Character switch timed out'));
            }, timeoutMilliseconds);

            this._activeJob.switchResolve = () => {
                clearTimeout(timeout);
                this._activeJob.characterSwitched = true;
                resolve();
            };

            this._activeJob.switchReject = (error) => {
                clearTimeout(timeout);
                reject(error);
            };
        });
    }

    /**
     * Releases the current job and processes the next one in queue.
     * Called when a job completes (success or failure).
     */
    releaseJob() {
        if (this._activeJob) {
            Logger.info(`Releasing job ${this._activeJob.job.id}`);

            if (this._onJobReleased) {
                this._onJobReleased(this._activeJob);
            }
        }

        this._activeJob = null;
        this._isProcessing = false;

        // Process next job in queue
        setImmediate(() => this._processNext());
    }

    /**
     * Handles disconnection mid-generation by notifying users and releasing lock.
     */
    async handleDisconnect() {
        if (this._activeJob) {
            const job = this._activeJob.job;
            if (this._disconnectNotifier) {
                await this._disconnectNotifier(
                    job,
                    'Connection to SillyTavern was lost during processing. Please try again.'
                );
            }

            // Reject any pending switch
            if (this._activeJob.switchReject) {
                this._activeJob.switchReject(new Error('SillyTavern disconnected'));
            }
        }

        // Clear all pending jobs
        for (const job of this._queue) {
            if (this._disconnectNotifier) {
                await this._disconnectNotifier(
                    job,
                    'Connection to SillyTavern was lost. Please try again later.'
                );
            }
        }
        this._queue.length = 0;

        // Notify about released job
        if (this._activeJob && this._onJobReleased) {
            this._onJobReleased(this._activeJob);
        }

        // Release lock
        this._activeJob = null;
        this._isProcessing = false;
    }

    /**
     * Clears all queued jobs and resets state.
     */
    clearQueue() {
        this._queue.length = 0;
        this._messageBuffers.clear();
        this._activeJob = null;
        this._isProcessing = false;
        Logger.info('Queue cleared');
    }

    /**
     * Resets the singleton instance (for testing).
     */
    static resetInstance() {
        QueueManager._instance = null;
    }
}

module.exports = QueueManager;
