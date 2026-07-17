const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const assert = require('assert');

const dbPath = path.resolve(__dirname, 'queue.db');
if (fs.existsSync(dbPath)) {
  fs.unlinkSync(dbPath);
}

const runCmd = (args) => {
  try {
    const stdout = execSync(`node bin/queuectl.js ${args}`, { stdio: 'pipe' });
    return { status: 0, stdout: stdout.toString().trim(), stderr: '' };
  } catch (err) {
    return { status: err.status, stdout: err.stdout.toString().trim(), stderr: err.stderr.toString().trim() };
  }
};

const c1 = runCmd('config set base_delay 1');
const c2 = runCmd('config set max-retries 2');
assert.strictEqual(c1.status, 0);
assert.strictEqual(c2.status, 0);

const e1 = runCmd(`enqueue '{"id": "success-job", "command": "echo hello"}'`);
const e2 = runCmd(`enqueue '{"id": "fail-job", "command": "false", "max_retries": 2}'`);
assert.strictEqual(e1.status, 0);
assert.strictEqual(e2.status, 0);

const s1 = runCmd('worker start --count 1');
assert.strictEqual(s1.status, 0);

execSync('sleep 0.5');

const stop1 = runCmd('worker stop');
assert.strictEqual(stop1.status, 0);

const Database = require('better-sqlite3');
let db = new Database(dbPath);

const j1 = db.prepare("SELECT * FROM jobs WHERE id = 'success-job'").get();
assert.strictEqual(j1.state, 'completed');

const j2 = db.prepare("SELECT * FROM jobs WHERE id = 'fail-job'").get();
assert.strictEqual(j2.state, 'failed');
assert.strictEqual(j2.attempts, 1);

db.close();

const s2 = runCmd('worker start --count 1');
assert.strictEqual(s2.status, 0);

execSync('sleep 2');

db = new Database(dbPath);
const j2_after = db.prepare("SELECT * FROM jobs WHERE id = 'fail-job'").get();
assert.strictEqual(j2_after.state, 'dead');
assert.strictEqual(j2_after.attempts, 2);
db.close();

const statusRes = runCmd('status');
assert.strictEqual(statusRes.status, 0);
assert.ok(statusRes.stdout.includes('Completed:  1'));
assert.ok(statusRes.stdout.includes('Dead (DLQ): 1'));

const listRes = runCmd('list-state dead');
assert.strictEqual(listRes.status, 0);
const deadList = JSON.parse(listRes.stdout);
assert.strictEqual(deadList.length, 1);
assert.strictEqual(deadList[0].id, 'fail-job');

const stop2 = runCmd('worker stop');
assert.strictEqual(stop2.status, 0);

console.log('Independent flow verification completed successfully!');
