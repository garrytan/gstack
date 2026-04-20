// BullMQ worker fixture — shape-detection-only in v1.
// /qa-headless should detect this as a 'queue worker' and route to manual guidance.

const { Worker } = require('bullmq');
const axios = require('axios');

const SLACK_WEBHOOK = process.env.SLACK_WEBHOOK_URL || 'https://hooks.slack.com/services/T/B/X';

const worker = new Worker('notifications', async (job) => {
  const { userId, message } = job.data;
  await axios.post(SLACK_WEBHOOK, {
    text: `User ${userId}: ${message}`,
  });
}, { connection: { host: 'localhost', port: 6379 } });

worker.on('completed', (job) => console.log(`done: ${job.id}`));
worker.on('failed',    (job, err) => console.error(`fail: ${job.id}: ${err.message}`));
