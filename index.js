require("dotenv").config();
const express = require("express");
const { spawn } = require("child_process");
const { randomUUID } = require("crypto");
const path = require("path");

const NPX = path.join(
  path.dirname(process.execPath),
  process.platform === "win32" ? "npx.cmd" : "npx"
);
const {
  StreamableHTTPServerTransport,
} = require("@modelcontextprotocol/sdk/server/streamableHttp.js");
const { isInitializeRequest } = require("@modelcontextprotocol/sdk/types.js");

const PORT = process.env.PORT || 3000;

const app = express();
app.use(express.json());

const sessions = new Map();

// Build the env vars for a child process from a DB prefix (DB1 or DB2)
function buildChildEnv(prefix) {
  return {
    MYSQL_HOST: process.env[`${prefix}_MYSQL_HOST`],
    MYSQL_PORT: process.env[`${prefix}_MYSQL_PORT`],
    MYSQL_USER: process.env[`${prefix}_MYSQL_USER`],
    MYSQL_PASS: process.env[`${prefix}_MYSQL_PASS`],
    MYSQL_DB:   process.env[`${prefix}_MYSQL_DB`],
    MYSQL_SSL:  process.env[`${prefix}_MYSQL_SSL`] || "false",
    ALLOW_INSERT_OPERATION: process.env[`${prefix}_ALLOW_INSERT`] || "false",
    ALLOW_UPDATE_OPERATION: process.env[`${prefix}_ALLOW_UPDATE`] || "false",
    ALLOW_DELETE_OPERATION: process.env[`${prefix}_ALLOW_DELETE`] || "false",
  };
}

// Spawn one MCP child process; returns { child, send(message) → Promise<response> }
function makeChild(envOverrides, label) {
  const child = spawn(
    process.platform === "win32" ? `"${NPX}"` : NPX,
    ["-y", "-p", "@benborla29/mcp-server-mysql", "mcp-server-mysql"],
    { env: { ...process.env, ...envOverrides }, stdio: ["pipe", "pipe", "pipe"], shell: process.platform === "win32" }
  );

  const pending = new Map();
  let buffer = "";

  child.stdout.on("data", (data) => {
    buffer += data.toString();
    const lines = buffer.split("\n");
    buffer = lines.pop();
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      let parsed;
      try { parsed = JSON.parse(trimmed); } catch { continue; }
      const id = parsed.id;
      if (id !== undefined && pending.has(id)) {
        const resolve = pending.get(id);
        pending.delete(id);
        resolve(parsed);
      }
    }
  });

  child.stdin.on("error", (err) => console.error(`[${label}] stdin error:`, err.code));
  child.stderr.on("data", (d) => console.error(`[${label}] ERR:`, d.toString().trim()));
  child.on("error", (err) => console.error(`[${label}] spawn error:`, err));
  child.on("exit", (code, sig) => console.error(`[${label}] exited code=${code} sig=${sig}`));

  function send(message) {
    return new Promise((resolve, reject) => {
      if (message.id !== undefined) {
        pending.set(message.id, resolve);
        setTimeout(() => {
          if (pending.has(message.id)) {
            pending.delete(message.id);
            reject(new Error(`[${label}] timeout for id=${message.id}`));
          }
        }, 30 * 60 * 1000); // 30 minutes
      }
      try {
        child.stdin.write(JSON.stringify(message) + "\n");
      } catch (err) {
        if (message.id !== undefined) pending.delete(message.id);
        return reject(err);
      }
      if (message.id === undefined) resolve(null);
    });
  }

  return { child, send };
}

// Wire the transport to two children, routing by tool-name prefix
function bridgeTransport(transport) {
  const db1Name = process.env.DB1_MYSQL_DB || "db1";
  const db2Name = process.env.DB2_MYSQL_DB || "db2";

  const db1 = makeChild(buildChildEnv("DB1"), db1Name);
  const db2 = makeChild(buildChildEnv("DB2"), db2Name);

  transport.onmessage = async (message) => {
    const { method, id } = message;
    try {
      if (method === "initialize") {
        // Initialise both children; use db1's protocol response
        const [r1] = await Promise.all([
          db1.send({ ...message, id: `__init_1_${id}` }),
          db2.send({ ...message, id: `__init_2_${id}` }),
        ]);
        await transport.send({ ...r1, id });

      } else if (method === "notifications/initialized") {
        try { db1.child.stdin.write(JSON.stringify(message) + "\n"); } catch {}
        try { db2.child.stdin.write(JSON.stringify(message) + "\n"); } catch {}

      } else if (method === "tools/list") {
        const [s1, s2] = await Promise.allSettled([
          db1.send({ ...message, id: `__list_1_${id}` }),
          db2.send({ ...message, id: `__list_2_${id}` }),
        ]);
        const tools = [
          ...(s2.status === "fulfilled" ? s2.value.result.tools.map((t) => ({ ...t, name: `${db2Name}_${t.name}`, description: `[PRIMARY — use this first. Client identifier column is sql_client_id] ${t.description}` })) : []),
          ...(s1.status === "fulfilled" ? s1.value.result.tools.map((t) => ({ ...t, name: `${db1Name}_${t.name}`, description: `[SECONDARY — use ONLY for: (1) restaurant_details which contains the true client details including accurate active/inactive status, (2) extraction log tables (extraction_log, daily_client_wise_extraction_logs, extraction_retry_audit, client_data_extraction_logs, client_wise_extraction_status)] ${t.description}` })) : []),
        ];
        if (s1.status === "rejected") console.error(`[${db1Name}] tools/list failed:`, s1.reason.message);
        if (s2.status === "rejected") console.error(`[${db2Name}] tools/list failed:`, s2.reason.message);
        await transport.send({ jsonrpc: "2.0", id, result: { tools } });

      } else if (method === "tools/call") {
        const toolName = message.params.name;
        const isDb1 = toolName.startsWith(`${db1Name}_`);
        const target  = isDb1 ? db1 : db2;
        const prefix  = isDb1 ? db1Name : db2Name;
        const actualName = toolName.slice(prefix.length + 1);
        const r = await target.send({
          ...message,
          params: { ...message.params, name: actualName },
        });
        await transport.send({ ...r, id });

      } else {
        try { db1.child.stdin.write(JSON.stringify(message) + "\n"); } catch {}
        try { db2.child.stdin.write(JSON.stringify(message) + "\n"); } catch {}
      }
    } catch (err) {
      console.error("router error:", err.message);
      if (id !== undefined) {
        await transport.send({
          jsonrpc: "2.0", id,
          error: { code: -32603, message: err.message },
        }).catch(() => {});
      }
    }
  };

  return { db1, db2 };
}

app.post("/mcp", async (req, res) => {
  const sessionId = req.headers["mcp-session-id"];

  if (sessionId && sessions.has(sessionId)) {
    return sessions.get(sessionId).transport.handleRequest(req, res, req.body);
  }

  if (!sessionId && isInitializeRequest(req.body)) {
    let dbs;
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: () => randomUUID(),
      onsessioninitialized: (id) => {
        sessions.set(id, { transport, db1: dbs.db1, db2: dbs.db2 });
        console.log(`[${id}] session opened`);
      },
    });

    transport.onclose = () => {
      const sid = transport.sessionId;
      if (sid && sessions.has(sid)) {
        const { db1, db2 } = sessions.get(sid);
        db1.child.kill();
        db2.child.kill();
        sessions.delete(sid);
        console.log(`[${sid}] session closed`);
      }
    };

    await transport.start();
    dbs = bridgeTransport(transport);
    return transport.handleRequest(req, res, req.body);
  }

  return res.status(400).json({
    jsonrpc: "2.0",
    error: { code: -32000, message: "Bad Request: no valid session ID" },
    id: req.body?.id ?? null,
  });
});

async function handleSessionRequest(req, res) {
  const sessionId = req.headers["mcp-session-id"];
  if (!sessionId || !sessions.has(sessionId)) {
    return res.status(400).send("Invalid or missing session ID");
  }
  return sessions.get(sessionId).transport.handleRequest(req, res);
}

app.get("/mcp", handleSessionRequest);
app.delete("/mcp", handleSessionRequest);

app.listen(PORT, () => {
  console.log(`MCP Streamable HTTP server running on http://localhost:${PORT}/mcp`);
});
