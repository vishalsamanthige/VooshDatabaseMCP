require("dotenv").config();

const PORT = process.env.PORT || 3000;

// How long to wait for a child MCP process to answer a single request before
// rejecting. Kept short on purpose: a hung/unreachable DB child must fail fast
// so the request is freed and the client can recover, instead of holding the
// call open (the old 30-minute value amplified reconnect storms).
const REQUEST_TIMEOUT_MS = Number(process.env.MCP_REQUEST_TIMEOUT_MS) || 120000; // 2 min

// Sessions with no activity for this long are torn down (children killed) so
// leaked/abandoned sessions can't accumulate and exhaust DB connections.
const SESSION_IDLE_TIMEOUT_MS =
  Number(process.env.MCP_SESSION_IDLE_MS) || 30 * 60 * 1000; // 30 min

// How often the idle-session reaper runs.
const SESSION_REAP_INTERVAL_MS =
  Number(process.env.MCP_SESSION_REAP_MS) || 60 * 1000; // 1 min

// Human-friendly names for each database, used as the tool-name prefix.
const DB1_NAME = process.env.DB1_MYSQL_DB || "db1";
const DB2_NAME = process.env.DB2_MYSQL_DB || "db2";

// Build the env vars for a child MCP process from a DB prefix (DB1 or DB2).
function buildChildEnv(prefix) {
  return {
    MYSQL_HOST: process.env[`${prefix}_MYSQL_HOST`],
    MYSQL_PORT: process.env[`${prefix}_MYSQL_PORT`],
    MYSQL_USER: process.env[`${prefix}_MYSQL_USER`],
    MYSQL_PASS: process.env[`${prefix}_MYSQL_PASS`],
    MYSQL_DB: process.env[`${prefix}_MYSQL_DB`],
    MYSQL_SSL: process.env[`${prefix}_MYSQL_SSL`] || "false",
    ALLOW_INSERT_OPERATION: process.env[`${prefix}_ALLOW_INSERT`] || "false",
    ALLOW_UPDATE_OPERATION: process.env[`${prefix}_ALLOW_UPDATE`] || "false",
    ALLOW_DELETE_OPERATION: process.env[`${prefix}_ALLOW_DELETE`] || "false",
  };
}

module.exports = {
  PORT,
  REQUEST_TIMEOUT_MS,
  SESSION_IDLE_TIMEOUT_MS,
  SESSION_REAP_INTERVAL_MS,
  DB1_NAME,
  DB2_NAME,
  buildChildEnv,
};
