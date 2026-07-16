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

module.exports = {
  db,
  enqueueJob
};
