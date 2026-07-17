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
  updateJobState,
  getConfig,
  setConfig,
  failJob,
  killJob,
  retryDeadJob
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

    const configMaxRetries = Number(getConfig('max_retries', '3'));
    const maxRetries = jobData.max_retries !== undefined ? Number(jobData.max_retries) : configMaxRetries;
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
      updated_at: timestamp,
      run_at: null
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
              const baseDelay = Number(getConfig('base_delay', '2'));
              if (job.attempts < job.max_retries) {
                const delay = baseDelay * (job.attempts ** 2);
                failJob(job.id, delay);
              } else {
                killJob(job.id);
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

const configCmd = program.command('config');

configCmd
  .command('set <key> <value>')
  .description('Set a configuration value')
  .action((key, value) => {
    let normalizedKey = key;
    if (key === 'max-retries' || key === 'max_retries') {
      normalizedKey = 'max_retries';
      const num = Number(value);
      if (isNaN(num) || !Number.isInteger(num) || num < 0) {
        console.error('Error: max_retries must be a non-negative integer');
        process.exit(1);
      }
      setConfig(normalizedKey, String(num));
      console.log(`Configured max_retries = ${num}`);
    } else if (key === 'base-delay' || key === 'base_delay') {
      normalizedKey = 'base_delay';
      const num = Number(value);
      if (isNaN(num) || !Number.isInteger(num) || num < 0) {
        console.error('Error: base_delay must be a non-negative integer');
        process.exit(1);
      }
      setConfig(normalizedKey, String(num));
      console.log(`Configured base_delay = ${num}`);
    } else {
      setConfig(normalizedKey, value);
      console.log(`Configured ${normalizedKey} = ${value}`);
    }
  });

const dlqCmd = program.command('dlq');

dlqCmd
  .command('list')
  .description('List all dead jobs')
  .action(() => {
    const deadJobs = db.prepare("SELECT * FROM jobs WHERE state = 'dead' ORDER BY created_at ASC").all();
    console.log(JSON.stringify(deadJobs, null, 2));
  });

dlqCmd
  .command('retry <jobId>')
  .description('Retry a dead job')
  .action((jobId) => {
    const success = retryDeadJob(jobId);
    if (success) {
      console.log(`Job ${jobId} reset to pending`);
    } else {
      console.error(`Error: Job ${jobId} is not in the DLQ`);
      process.exit(1);
    }
  });

program
  .command('status')
  .description('Show summary of all job states and active workers')
  .action(() => {
    const states = ['pending', 'processing', 'completed', 'failed', 'dead'];
    const summary = {};
    for (const state of states) {
      const res = db.prepare('SELECT COUNT(*) as count FROM jobs WHERE state = ?').get(state);
      summary[state] = res.count;
    }
    const activeWorkers = db.prepare('SELECT COUNT(*) as count FROM workers').get().count;

    console.log('=== Queue Status ===');
    console.log(`Pending:    ${summary.pending}`);
    console.log(`Processing: ${summary.processing}`);
    console.log(`Completed:  ${summary.completed}`);
    console.log(`Failed:     ${summary.failed}`);
    console.log(`Dead (DLQ): ${summary.dead}`);
    console.log('=== Worker Status ===');
    console.log(`Active Workers: ${activeWorkers}`);
  });

program
  .command('list-state <stateName>')
  .description('List jobs by their state')
  .action((stateName) => {
    const validStates = ['pending', 'processing', 'completed', 'failed', 'dead'];
    if (!validStates.includes(stateName)) {
      console.error(`Error: Invalid state name "${stateName}". Valid states: ${validStates.join(', ')}`);
      process.exit(1);
    }
    const jobs = db.prepare('SELECT * FROM jobs WHERE state = ? ORDER BY created_at ASC').all(stateName);
    console.log(JSON.stringify(jobs, null, 2));
  });

program.parse(process.argv);
