const Logger = require('../utils/logger');

class QueueManager {
    constructor() {
        this.queue = [];
        this.isProcessing = false;
        this.activeJob = null;
    }

    /**
     * adds a job to the queue
     * @param {Object} job 
     */
    enqueueJob(job) {
        job.id = `job_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
        job.timestamp = Date.now();
        
        this.queue.push(job);
        Logger.info(`Job ${job.id} enqueued for character "${job.targetCharacter}" (queue size: ${this.queue.length})`);
        
        // Attempt to process
        return this.processNext();
    }

    async processNext() {
        if (this.isProcessing || this.queue.length === 0) {
            return;
        }

        this.isProcessing = true;
        const job = this.queue.shift();
        
        this.activeJob = {
            job: job,
            characterSwitched: false
        };

        Logger.info(`Processing job ${job.id} for bot "${job.targetCharacter}"`);
        
        return this.activeJob;
    }

    releaseJob() {
        if (this.activeJob) {
            Logger.info(`Releasing job ${this.activeJob.job.id}`);
        }
        
        this.activeJob = null;
        this.isProcessing = false;
        
        // Process next immediately
        setImmediate(() => this.processNext());
    }

    getActiveJob() {
        return this.activeJob;
    }

    clearQueue() {
        this.queue = [];
        this.activeJob = null;
        this.isProcessing = false;
    }
}

module.exports = new QueueManager();
