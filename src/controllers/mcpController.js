const { handleMessage } = require("../services/bridgeService");

// Stateless MCP over Streamable HTTP (spec 2026-07-28, SEP-2575): no
// Mcp-Session-Id, no required handshake, every POST is self-contained. Legacy
// clients that still send `initialize` are served too (also without state).
const META = "io.modelcontextprotocol";
const LATEST = "2026-07-28";
const LEGACY = "2025-06-18";
const SUPPORTED = [LATEST, "2025-11-25", LEGACY, "2025-03-26"];
const SERVER_INFO = { name: "voosh-db-mcp", version: "1.0.0" };

const ctx = {
  supportedVersions: SUPPORTED,
  legacyVersion: LEGACY,
  serverInfo: SERVER_INFO,
};

const fail = (res, status, code, message, data) =>
  res.status(status).json({
    jsonrpc: "2.0",
    id: null,
    error: { code, message, ...(data !== undefined && { data }) },
  });

// Validate protocol version + routing headers against the body. Returns true
// when it already sent an error response.
function rejectInvalid(req, res, message) {
  const header = req.get("mcp-protocol-version");
  const metaVersion = message.params?._meta?.[`${META}/protocolVersion`];
  const version = metaVersion ?? header;

  if (metaVersion && header && metaVersion !== header) {
    fail(res, 400, -32602, "MCP-Protocol-Version header does not match _meta");
    return true;
  }
  // Legacy initialize negotiates its own version in the body.
  if (version && message.method !== "initialize" && !SUPPORTED.includes(version)) {
    fail(res, 400, -32022, "Unsupported protocol version", {
      supported: SUPPORTED,
      requested: version,
    });
    return true;
  }
  const mcpMethod = req.get("mcp-method");
  if (mcpMethod && mcpMethod !== message.method) {
    fail(res, 400, -32602, "Mcp-Method header does not match body");
    return true;
  }
  const mcpName = req.get("mcp-name");
  if (mcpName && message.params?.name !== undefined && mcpName !== message.params.name) {
    fail(res, 400, -32602, "Mcp-Name header does not match body");
    return true;
  }
  return false;
}

// POST /mcp
async function handlePost(req, res) {
  const message = req.body;
  if (!message || Array.isArray(message) || message.jsonrpc !== "2.0" || !message.method) {
    return fail(res, 400, -32600, "Invalid Request: expected a single JSON-RPC message");
  }
  if (rejectInvalid(req, res, message)) return;

  const response = await handleMessage(message, ctx);
  if (!response) return res.status(202).end(); // notification accepted

  const unknownMethod = response.error?.code === -32601;
  const modern = (req.get("mcp-protocol-version") ?? "") >= LATEST;
  return res.status(unknownMethod && modern ? 404 : 200).json(response);
}

// GET / DELETE /mcp — no server->client stream and no session to terminate.
function methodNotAllowed(req, res) {
  res.set("Allow", "POST");
  fail(res, 405, -32000, "Method not allowed in stateless mode");
}

module.exports = { handlePost, methodNotAllowed };
