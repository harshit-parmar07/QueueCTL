# QueueCTL - CLI-Based Background Job Queue System

QueueCTL is a lightweight, production-grade, local background job queue CLI built with Node.js and SQLite. It executes job commands in parallel across multiple worker processes, supports automatic retries with exponential backoff, manages a Dead Letter Queue (DLQ) for permanently failed tasks, and shuts down gracefully without disrupting active jobs.

---

## 1. Setup and Installation

### Prerequisites
- Node.js (v18 or higher recommended)
- npm

### Installation Steps
1. Navigate to the project root directory:
   ```bash
   cd queuectl-backend
   ```
2. Install all npm dependencies:
   ```bash
   npm install
   ```
3. Link the CLI globally to enable the `queuectl` command:
   ```bash
   npm link
   ```
   *(Note: You may need `sudo npm link` depending on your global node installation permissions.)*

---

## 2. CLI Usage Examples

### Enqueue a Job
Adds a new command payload to the queue.
- **Command**:
  ```bash
  queuectl enqueue '{"id": "job1", "command": "sleep 2"}'
  ```
- **Expected Output**:
  ```
  Job enqueued successfully: job1
  ```

### Start Workers
Spawns background worker instances to process enqueued jobs.
- **Command**:
  ```bash
  queuectl worker start --count 3
  ```
- **Expected Output**:
  ```
  Started 3 workers.
  ```

### Stop Workers Gracefully
Signals all active workers to terminate. Workers finish their active job execution before exiting.
- **Command**:
  ```bash
  queuectl worker stop
  ```
- **Expected Output**:
  ```
  Stopping workers gracefully...
  All workers stopped.
  ```

### Check Queue Status
Displays current job state counts and active worker numbers.
- **Command**:
  ```bash
  queuectl status
  ```
- **Expected Output**:
  ```
  === Queue Status ===
  Pending:    2
  Processing: 0
  Completed:  3
  Failed:     1
  Dead (DLQ): 1
  === Worker Status ===
  Active Workers: 0
  ```

### Filter Jobs by State
Lists jobs currently holding a specific state name in JSON format.
- **Command**:
  ```bash
  queuectl list-state completed
  ```
- **Expected Output**:
  ```json
  [
    {
      "id": "job1",
      "command": "sleep 2",
      "state": "completed",
      "attempts": 1,
      "max_retries": 3,
      "created_at": "2026-07-17T18:40:00.000Z",
      "updated_at": "2026-07-17T18:40:02.100Z",
      "run_at": null
    }
  ]
  ```

### Set Configuration Values
Updates retry threshold and backoff delay baseline.
- **Command**:
  ```bash
  queuectl config set max-retries 5
  ```
- **Expected Output**:
  ```
  Configured max_retries = 5
  ```

### List Dead Letter Queue (DLQ)
Lists jobs that have exhausted all retries and are marked `dead`.
- **Command**:
  ```bash
  queuectl dlq list
  ```
- **Expected Output**:
  ```json
  [
    {
      "id": "job2",
      "command": "false",
      "state": "dead",
      "attempts": 3,
      "max_retries": 3,
      "created_at": "2026-07-17T18:41:00.000Z",
      "updated_at": "2026-07-17T18:41:10.500Z",
      "run_at": null
    }
  ]
  ```

### Retry a DLQ Job
Resets a dead job back to pending state so it can be re-executed.
- **Command**:
  ```bash
  queuectl dlq retry job2
  ```
- **Expected Output**:
  ```
  Job job2 reset to pending
  ```

---

## 3. System Architecture

```
   ┌────────────────────────────────────────────────────────┐
   │                       CLI Commands                     │
   │  (enqueue, status, list-state, config, dlq list/retry) │
   └───────────────────────────┬────────────────────────────┘
                               │ Reads/Writes
                               ▼
   ┌────────────────────────────────────────────────────────┐
   │                  SQLite Database (queue.db)            │
   │  [jobs] table, [workers] table, [config] table         │
   └───────────────────────────▲────────────────────────────┘
                               │ Acquires IMMEDIATE lock,
                               │ Reads pending jobs,
                               │ Updates state & attempts.
                               │
   ┌───────────────────────────┴────────────────────────────┐
   │                  Worker Background Engine              │
   │  (Runs loop: checks run_at, child execs, retries/DLQ)  │
   └────────────────────────────────────────────────────────┘
```

### Job Lifecycle States
- **`pending`**: Initial state of enqueued jobs. Eligible to be picked up by workers.
- **`processing`**: Under active execution by a worker child process.
- **`completed`**: Finished running with exit code `0`.
- **`failed`**: Execution returned non-zero exit status, and remaining retries exist. Job is delayed using exponential backoff.
- **`dead`**: Failed execution, and attempts met or exceeded `max_retries`. Moved to DLQ.

### Data Persistence
Persisted in local SQLite database `queue.db` within the project root folder.
- **`jobs`**: Stores job metadata, execution attempts, states, and scheduling information (`run_at`).
- **`workers`**: Records active worker PIDs to monitor capacity and manage graceful terminations.
- **`config`**: Holds dynamic parameters (`max_retries`, `base_delay`).

### Concurrency and Locking Strategy
Under multi-worker conditions, race-condition safety is achieved using SQLite `BEGIN IMMEDIATE` transaction execution in `better-sqlite3`. When a worker checks for a job, it locks the SQLite database exclusively for writes, reads the oldest available job, and immediately marks it as `processing` before committing the transaction and unlocking. This ensures that no two workers can read or execute the same job.

---

## 4. Assumptions & Trade-offs

### SQLite Database Storage
- **Choice**: Storing state in SQLite instead of a JSON file or PostgreSQL server.
- **Trade-off**: While Redis or PostgreSQL are standard for massive network-distributed processing, SQLite offers zero-configuration local persistence, instant startup, and transactional guarantees (`BEGIN IMMEDIATE` row-locking) ideal for single-node CLI utilities.

### Process-Based Workers
- **Choice**: Launching worker processes using Node's `child_process.spawn(..., { detached: true })` and tracking PIDs in SQLite.
- **Trade-off**: Detached child processes run outside the lifecycle of the parent terminal CLI. By using a database table to keep track of active worker PIDs, we avoid requiring heavier daemon managers (like PM2 or systemd), maintaining portability while ensuring full management from `queuectl`.

---

## 5. Running Verification Flows

We provide an automated verification suite that runs enqueuing, execution loops, retries, and restarts.

To run the verification suite:
```bash
node test.js
```
The test suite will print progress outputs and exit with code `0` if all assertions pass:
```
Independent flow verification completed successfully!
```

---

## 6. Demonstration Video


