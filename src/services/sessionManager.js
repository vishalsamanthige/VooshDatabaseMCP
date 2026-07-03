const {
  SESSION_IDLE_TIMEOUT_MS,
  SESSION_REAP_INTERVAL_MS,
} = require("../config");

// In-memory registry of active MCP sessions. Each entry owns a transport and
// its two backing child processes, plus a lastActive timestamp for reaping.
const sessions = new Map();

function has(sessionId) {
  return sessions.has(sessionId);
}

function get(sessionId) {
  return sessions.get(sessionId);
}

function add(sessionId, { transport, db1, db2 }) {
  sessions.set(sessionId, { transport, db1, db2, lastActive: Date.now() });
  console.log(`[${sessionId}] session opened`);
}

// Record activity so the reaper doesn't tear down a session that's in use.
function touch(sessionId) {
  const s = sessions.get(sessionId);
  if (s) s.lastActive = Date.now();
}

// Tear down a session: kill both children and drop the entry.
function remove(sessionId) {
  if (!sessions.has(sessionId)) return;
  const { db1, db2 } = sessions.get(sessionId);
  db1.kill();
  db2.kill();
  sessions.delete(sessionId);
  console.log(`[${sessionId}] session closed`);
}

// Periodically reap sessions that have been idle past the threshold, so leaked
// or abandoned sessions (client vanished without a clean DELETE) can't pile up
// and exhaust DB connections.
const reaper = setInterval(() => {
  const now = Date.now();
  for (const [id, s] of sessions) {
    if (now - s.lastActive > SESSION_IDLE_TIMEOUT_MS) {
      console.log(`[${id}] session idle-expired`);
      remove(id);
      try {
        s.transport.close();
      } catch {
        /* already closing — ignore */
      }
    }
  }
}, SESSION_REAP_INTERVAL_MS);
reaper.unref(); // don't keep the process alive just for the reaper

module.exports = { has, get, add, touch, remove };
