// In-memory registry of active MCP sessions. Each entry owns a transport and
// its two backing child processes.
const sessions = new Map();

function has(sessionId) {
  return sessions.has(sessionId);
}

function get(sessionId) {
  return sessions.get(sessionId);
}

function add(sessionId, { transport, db1, db2 }) {
  sessions.set(sessionId, { transport, db1, db2 });
  console.log(`[${sessionId}] session opened`);
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

module.exports = { has, get, add, remove };
