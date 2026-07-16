#!/usr/bin/env node

const { Command } = require('commander');
const { spawn, exec } = require('child_process');
const path = require('path');
const {
  enqueueJob,
  db,
  registerWorker,
  deregisterWorker,
  getNextJob,
  updateJobState
} = require('../db');

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

const workerCmd = program.command('worker');

workerCmd
  .command('start')
  .description('Start one or more workers')
  .option('-c, --count <count>', 'Number of workers to start', '1')
  .action((options) => {
    const count = parseInt(options.count, 10);
    if (isNaN(count) || count <= 0) {
      console.error('Error: Count must be a positive integer');
      process.exit(1);
    }
    const scriptPath = path.resolve(__dirname, 'queuectl.js');
    for (let i = 0; i < count; i++) {
      const child = spawn(process.argv[0], [scriptPath, 'worker', 'run'], {
        detached: true,
        stdio: 'ignore'
      });
      child.unref();
    }
    console.log(`Started ${count} workers.`);
  });

workerCmd
  .command('stop')
  .description('Stop running workers gracefully')
  .action(async () => {
    console.log('Stopping workers gracefully...');
    const workers = db.prepare('SELECT pid FROM workers').all();
    if (workers.length === 0) {
      console.log('No active workers found.');
      return;
    }
    for (const w of workers) {
      try {
        process.kill(w.pid, 0);
        process.kill(w.pid, 'SIGTERM');
      } catch (err) {
        db.prepare('DELETE FROM workers WHERE pid = ?').run(w.pid);
      }
    }
    let attempts = 0;
    while (attempts < 30) {
      const activeCount = db.prepare('SELECT COUNT(*) as count FROM workers').get().count;
      if (activeCount === 0) {
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 500));
      attempts++;
    }
    console.log('All workers stopped.');
  });

workerCmd
  .command('run')
  .description('Run worker job processing loop')
  .action(async () => {
    const pid = process.pid;
    registerWorker(pid);

    let isShuttingDown = false;
    let isProcessing = false;

    const handleShutdown = () => {
      isShuttingDown = true;
      if (!isProcessing) {
        deregisterWorker(pid);
        process.exit(0);
      }
    };

    process.on('SIGTERM', handleShutdown);
    process.on('SIGINT', handleShutdown);

    while (true) {
      if (isShuttingDown) {
        deregisterWorker(pid);
        process.exit(0);
      }

      let job = null;
      try {
        job = getNextJob();
      } catch (err) {
      }

      if (job) {
        isProcessing = true;
        await new Promise((resolve) => {
          exec(job.command, (err) => {
            if (err) {
              const attempts = job.attempts;
              const maxRetries = job.max_retries;
              if (attempts < maxRetries) {
                updateJobState(job.id, 'failed');
              } else {
                updateJobState(job.id, 'dead');
              }
            } else {
              updateJobState(job.id, 'completed');
            }
            resolve();
          });
        });
        isProcessing = false;
      } else {
        await new Promise((resolve) => setTimeout(resolve, 1000));
      }
    }
  });

program.parse(process.argv);
