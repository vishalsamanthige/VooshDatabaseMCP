const { handleMessage } = require("../services/bridgeService");
const { ALLOWED_ORIGINS } = require("../config");

// Stateless MCP over Streamable HTTP (spec 2026-07-28, SEP-2575): no
// Mcp-Session-Id, no handshake, every POST is self-contained.
const META = "io.modelcontextprotocol";
const VERSION = "2026-07-28";
const SUPPORTED = [VERSION];
const NAMED_METHODS = new Set(["tools/call", "resources/read", "prompts/get"]);

const ctx = {
  supportedVersions: SUPPORTED,
  serverInfo: { name: "voosh-db-mcp", version: "1.0.0" },
};

const fail = (res, status, code, message, data) =>
  res.status(status).json({
    jsonrpc: "2.0",
    id: null,
    error: { code, message, ...(data !== undefined && { data }) },
  });

// Header values that are not plain ASCII are sent as "=?base64?...?=".
const decodeHeader = (v) => {
  const m = /^=\?base64\?(.*)\?=$/.exec(v);
  return m ? Buffer.from(m[1], "base64").toString("utf8") : v;
};

// Validate origin, headers and _meta against the body. Returns true when it
// already sent an error response.
function rejectInvalid(req, res, message) {
  const origin = req.get("origin");
  if (origin && !ALLOWED_ORIGINS.includes(origin)) {
    fail(res, 403, -32000, "Forbidden: origin not allowed");
    return true;
  }

  const meta = message.params?._meta;
  const header = req.get("mcp-protocol-version");
  const metaVersion = meta?.[`${META}/protocolVersion`];

  // Headers: missing or disagreeing with the body → HeaderMismatch.
  const mismatch = (what) => {
    fail(res, 400, -32020, `Header mismatch: ${what}`);
    return true;
  };
  if (!header) return mismatch("MCP-Protocol-Version missing");
  if (metaVersion && header !== metaVersion)
    return mismatch("MCP-Protocol-Version differs from _meta");
  const mcpMethod = req.get("mcp-method");
  if (mcpMethod !== message.method) return mismatch("Mcp-Method differs from body");
  if (NAMED_METHODS.has(message.method)) {
    const name = req.get("mcp-name");
    const bodyName = message.params?.name ?? message.params?.uri;
    if (name === undefined || decodeHeader(name) !== bodyName)
      return mismatch("Mcp-Name differs from body");
  }

  if (!SUPPORTED.includes(header)) {
    fail(res, 400, -32022, "Unsupported protocol version", {
      supported: SUPPORTED,
      requested: header,
    });
    return true;
  }

  // _meta: protocolVersion and clientCapabilities are required on every request.
  if (!metaVersion || meta[`${META}/clientCapabilities`] === undefined) {
    fail(res, 400, -32602, "_meta must include protocolVersion and clientCapabilities");
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
  if (!response) return res.status(202).end();
  return res.status(response.error?.code === -32601 ? 404 : 200).json(response);
}

// GET / DELETE /mcp — no server->client stream and no session to terminate.
function methodNotAllowed(req, res) {
  res.set("Allow", "POST");
  fail(res, 405, -32000, "Method not allowed in stateless mode");
}

module.exports = { handlePost, methodNotAllowed };
