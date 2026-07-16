#!/usr/bin/env node

const { Command } = require('commander');
const { enqueueJob } = require('../db');

const program = new Command();

program
  .name('queuectl')
  .description('CLI background job queue system')
  .version('1.0.0');

program
  .command('enqueue <json-string>')
  .description('Add a new job to the queue')
  .action((jsonString) => {
    let jobData;
    try {
      jobData = JSON.parse(jsonString);
    } catch (err) {
      console.error('Error: Invalid JSON input format');
      process.exit(1);
    }

    if (!jobData || typeof jobData !== 'object' || Array.isArray(jobData)) {
      console.error('Error: Job data must be a JSON object');
      process.exit(1);
    }

    if (!jobData.id || typeof jobData.id !== 'string' || jobData.id.trim() === '') {
      console.error('Error: Missing or invalid required field "id"');
      process.exit(1);
    }

    if (!jobData.command || typeof jobData.command !== 'string' || jobData.command.trim() === '') {
      console.error('Error: Missing or invalid required field "command"');
      process.exit(1);
    }

    const maxRetries = jobData.max_retries !== undefined ? Number(jobData.max_retries) : 3;
    if (isNaN(maxRetries) || !Number.isInteger(maxRetries) || maxRetries < 0) {
      console.error('Error: Field "max_retries" must be a non-negative integer');
      process.exit(1);
    }

    const timestamp = new Date().toISOString();

    const job = {
      id: jobData.id.trim(),
      command: jobData.command.trim(),
      state: 'pending',
      attempts: 0,
      max_retries: maxRetries,
      created_at: timestamp,
      updated_at: timestamp
    };

    try {
      enqueueJob(job);
      console.log(`Job enqueued successfully: ${job.id}`);
    } catch (err) {
      if (err.code === 'SQLITE_CONSTRAINT_PRIMARYKEY') {
        console.error(`Error: Job ID "${job.id}" already exists`);
      } else {
        console.error(`Error enqueuing job: ${err.message}`);
      }
      process.exit(1);
    }
  });

program.parse(process.argv);
