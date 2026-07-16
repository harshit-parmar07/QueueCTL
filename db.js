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
    updated_at TEXT NOT NULL
  )
`);

db.exec(`
  CREATE TABLE IF NOT EXISTS workers (
    pid INTEGER PRIMARY KEY,
    state TEXT NOT NULL
  )
`);

function enqueueJob(job) {
  const stmt = db.prepare(`
    INSERT INTO jobs (id, command, state, attempts, max_retries, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `);
  stmt.run(
    job.id,
    job.command,
    job.state,
    job.attempts,
    job.max_retries,
    job.created_at,
    job.updated_at
  );
}

function registerWorker(pid) {
  db.prepare('INSERT OR REPLACE INTO workers (pid, state) VALUES (?, ?)').run(pid, 'active');
}

function deregisterWorker(pid) {
  db.prepare('DELETE FROM workers WHERE pid = ?').run(pid);
}

const getNextJobTx = db.transaction(() => {
  const job = db.prepare(`
    SELECT * FROM jobs
    WHERE state = 'pending'
    ORDER BY created_at ASC
    LIMIT 1
  `).get();
  if (job) {
    db.prepare(`
      UPDATE jobs
      SET state = 'processing', attempts = attempts + 1, updated_at = ?
      WHERE id = ?
    `).run(new Date().toISOString(), job.id);
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

module.exports = {
  db,
  enqueueJob,
  registerWorker,
  deregisterWorker,
  getNextJob,
  updateJobState
};
