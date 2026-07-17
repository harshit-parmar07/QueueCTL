const Database = require('better-sqlite3');
const path = require('path');

const dbPath = path.resolve(__dirname, 'queue.db');
const db = new Database(dbPath);

db.exec(`
  CREATE TABLE IF NOT EXISTS jobs (
    id TEXT PRIMARY KEY,
    command TEXT NOT NULL,
    state TEXT NOT NULL DEFAULT 'pending',
    attempts INTEGER NOT NULL DEFAULT 0,
    max_retries INTEGER NOT NULL DEFAULT 3,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    run_at TEXT
  )
`);

try {
  db.exec('ALTER TABLE jobs ADD COLUMN run_at TEXT');
} catch (err) {
}

db.exec(`
  CREATE TABLE IF NOT EXISTS workers (
    pid INTEGER PRIMARY KEY,
    state TEXT NOT NULL
  )
`);

db.exec(`
  CREATE TABLE IF NOT EXISTS config (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
  )
`);

function enqueueJob(job) {
  const stmt = db.prepare(`
    INSERT INTO jobs (id, command, state, attempts, max_retries, created_at, updated_at, run_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `);
  stmt.run(
    job.id,
    job.command,
    job.state,
    job.attempts,
    job.max_retries,
    job.created_at,
    job.updated_at,
    job.run_at
  );
}

function registerWorker(pid) {
  db.prepare('INSERT OR REPLACE INTO workers (pid, state) VALUES (?, ?)').run(pid, 'active');
}

function deregisterWorker(pid) {
  db.prepare('DELETE FROM workers WHERE pid = ?').run(pid);
}

const getNextJobTx = db.transaction(() => {
  const currentTime = new Date().toISOString();
  const job = db.prepare(`
    SELECT * FROM jobs
    WHERE state = 'pending' OR (state = 'failed' AND (run_at IS NULL OR run_at <= ?))
    ORDER BY created_at ASC
    LIMIT 1
  `).get(currentTime);
  if (job) {
    db.prepare(`
      UPDATE jobs
      SET state = 'processing', attempts = attempts + 1, updated_at = ?
      WHERE id = ?
    `).run(currentTime, job.id);
    job.attempts += 1;
    return job;
  }
  return null;
});

function getNextJob() {
  return getNextJobTx.immediate();
}

function updateJobState(id, state) {
  db.prepare('UPDATE jobs SET state = ?, updated_at = ? WHERE id = ?').run(state, new Date().toISOString(), id);
}

function getConfig(key, defaultValue) {
  const row = db.prepare('SELECT value FROM config WHERE key = ?').get(key);
  return row ? row.value : defaultValue;
}

function setConfig(key, value) {
  db.prepare('INSERT OR REPLACE INTO config (key, value) VALUES (?, ?)').run(key, String(value));
}

function failJob(id, delaySeconds) {
  const runAt = new Date(Date.now() + delaySeconds * 1000).toISOString();
  db.prepare('UPDATE jobs SET state = ?, run_at = ?, updated_at = ? WHERE id = ?').run(
    'failed',
    runAt,
    new Date().toISOString(),
    id
  );
}

function killJob(id) {
  db.prepare('UPDATE jobs SET state = ?, run_at = NULL, updated_at = ? WHERE id = ?').run(
    'dead',
    new Date().toISOString(),
    id
  );
}

function retryDeadJob(id) {
  const stmt = db.prepare(`
    UPDATE jobs
    SET state = 'pending', attempts = 0, run_at = NULL, updated_at = ?
    WHERE id = ? AND state = 'dead'
  `);
  const res = stmt.run(new Date().toISOString(), id);
  return res.changes > 0;
}

module.exports = {
  db,
  enqueueJob,
  registerWorker,
  deregisterWorker,
  getNextJob,
  updateJobState,
  getConfig,
  setConfig,
  failJob,
  killJob,
  retryDeadJob
};
