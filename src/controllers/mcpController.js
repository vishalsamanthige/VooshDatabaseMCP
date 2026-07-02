const { randomUUID } = require("crypto");
const {
  StreamableHTTPServerTransport,
} = require("@modelcontextprotocol/sdk/server/streamableHttp.js");
const { isInitializeRequest } = require("@modelcontextprotocol/sdk/types.js");

const sessionManager = require("../services/sessionManager");
const { bridgeTransport } = require("../services/bridgeService");

// POST /mcp — either dispatches to an existing session or opens a new one on
// an initialize request.
async function handlePost(req, res) {
  const sessionId = req.headers["mcp-session-id"];

  if (sessionId && sessionManager.has(sessionId)) {
    return sessionManager
      .get(sessionId)
      .transport.handleRequest(req, res, req.body);
  }

  if (!sessionId && isInitializeRequest(req.body)) {
    let dbs;
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: () => randomUUID(),
      onsessioninitialized: (id) => {
        sessionManager.add(id, { transport, db1: dbs.db1, db2: dbs.db2 });
      },
    });

    transport.onclose = () => {
      if (transport.sessionId) sessionManager.remove(transport.sessionId);
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
}

// GET / DELETE /mcp — require an existing session.
async function handleSessionRequest(req, res) {
  const sessionId = req.headers["mcp-session-id"];
  if (!sessionId || !sessionManager.has(sessionId)) {
    return res.status(400).send("Invalid or missing session ID");
  }
  return sessionManager.get(sessionId).transport.handleRequest(req, res);
}

module.exports = { handlePost, handleSessionRequest };
