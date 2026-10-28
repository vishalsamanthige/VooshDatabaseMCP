const McpChild = require("../models/McpChild");
const { DB1_NAME, DB2_NAME, buildChildEnv } = require("../config");

// Stateless bridge: the MCP layer keeps no per-client state. Two shared child
// DB processes are started lazily, handshaken once, and reused by every
// request (they hold only a DB pool, no client/session data).
let backends = null; // Promise<{ db1, db2 }>
let seq = 0;
const nextId = (tag) => `__${tag}_${++seq}`;

async function startBackends() {
  const db1 = new McpChild(buildChildEnv("DB1"), DB1_NAME);
  const db2 = new McpChild(buildChildEnv("DB2"), DB2_NAME);
  const init = {
    jsonrpc: "2.0",
    method: "initialize",
    params: {
      protocolVersion: "2025-03-26",
      capabilities: {},
      clientInfo: { name: "voosh-db-mcp-bridge", version: "1.0.0" },
    },
  };
  try {
    await Promise.all([
      db1.send({ ...init, id: nextId("init1") }),
      db2.send({ ...init, id: nextId("init2") }),
    ]);
  } catch (err) {
    db1.kill();
    db2.kill();
    throw err;
  }
  const initialized = { jsonrpc: "2.0", method: "notifications/initialized" };
  db1.write(initialized);
  db2.write(initialized);
  return { db1, db2 };
}

// Reuse the shared children; restart if either died or startup failed.
async function getBackends() {
  const current = backends;
  if (current) {
    try {
      const b = await current;
      if (!b.db1.dead && !b.db2.dead) return b;
      b.db1.kill();
      b.db2.kill();
    } catch {
      /* startup failed — fall through and retry */
    }
  }
  // Only the first caller to notice the failure restarts; others reuse it.
  if (backends === current) {
    backends = startBackends();
    backends.catch(() => {});
  }
  return backends;
}

const rpcError = (id, code, message, data) => ({
  jsonrpc: "2.0",
  id,
  error: { code, message, ...(data !== undefined && { data }) },
});

const listTools = (settled, name, label) => {
  if (settled.status === "rejected") {
    console.error(`[${name}] tools/list failed:`, settled.reason.message);
    return [];
  }
  return (settled.value.result?.tools ?? []).map((t) => ({
    ...t,
    name: `${name}_${t.name}`,
    description: `${label} ${t.description}`,
  }));
};

const PRIMARY =
  "[PRIMARY — use this first. Client identifier column is sql_client_id]";
const SECONDARY =
  "[SECONDARY — use ONLY for: (1) restaurant_details which contains the true client details including accurate active/inactive status, (2) extraction log tables (extraction_log, daily_client_wise_extraction_logs, extraction_retry_audit, client_data_extraction_logs, client_wise_extraction_status)]";

// Route one JSON-RPC message. Returns the response object, or null for
// notifications.
async function handleMessage(message, ctx) {
  const { method, id } = message;
  if (id === undefined) return null; // notifications: nothing to do, nothing to forward

  try {
    switch (method) {
      case "server/discover":
        return {
          jsonrpc: "2.0",
          id,
          result: {
            resultType: "complete",
            ttlMs: 300000,
            cacheScope: "public",
            supportedVersions: ctx.supportedVersions,
            capabilities: { tools: {} },
            _meta: {
              "io.modelcontextprotocol/serverInfo": ctx.serverInfo,
            },
          },
        };

      case "tools/list": {
        const { db1, db2 } = await getBackends();
        const [s1, s2] = await Promise.allSettled([
          db1.send({ ...message, id: nextId("list1") }),
          db2.send({ ...message, id: nextId("list2") }),
        ]);
        return {
          jsonrpc: "2.0",
          id,
          result: {
            resultType: "complete",
            // Tool set is static per deploy, so it is safe to cache publicly.
            ttlMs: 300000,
            cacheScope: "public",
            tools: [
              ...listTools(s2, DB2_NAME, PRIMARY),
              ...listTools(s1, DB1_NAME, SECONDARY),
            ],
          },
        };
      }

      case "tools/call": {
        const { db1, db2 } = await getBackends();
        const toolName = message.params?.name ?? "";
        const isDb1 = toolName.startsWith(`${DB1_NAME}_`);
        if (!isDb1 && !toolName.startsWith(`${DB2_NAME}_`)) {
          return rpcError(id, -32602, `Unknown tool: ${toolName}`);
        }
        const prefix = isDb1 ? DB1_NAME : DB2_NAME;
        const r = await (isDb1 ? db1 : db2).send({
          ...message,
          id: nextId("call"),
          params: { ...message.params, name: toolName.slice(prefix.length + 1) },
        });
        return {
          ...r,
          id,
          ...(r.result && { result: { resultType: "complete", ...r.result } }),
        };
      }

      default:
        return rpcError(id, -32601, `Method not found: ${method}`);
    }
  } catch (err) {
    console.error("router error:", err.message);
    return rpcError(id, -32603, err.message);
  }
}

module.exports = { handleMessage };
