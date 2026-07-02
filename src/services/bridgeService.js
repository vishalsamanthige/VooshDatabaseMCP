const McpChild = require("../models/McpChild");
const { DB1_NAME, DB2_NAME, buildChildEnv } = require("../config");

// Wire an MCP transport to two backing children, routing by tool-name prefix.
// Returns the two children so their lifecycle can be tracked by the session.
function bridgeTransport(transport) {
  const db1 = new McpChild(buildChildEnv("DB1"), DB1_NAME);
  const db2 = new McpChild(buildChildEnv("DB2"), DB2_NAME);

  transport.onmessage = async (message) => {
    const { method, id } = message;
    try {
      if (method === "initialize") {
        // Initialise both children; reply with db1's protocol response.
        const [r1] = await Promise.all([
          db1.send({ ...message, id: `__init_1_${id}` }),
          db2.send({ ...message, id: `__init_2_${id}` }),
        ]);
        await transport.send({ ...r1, id });
      } else if (method === "notifications/initialized") {
        db1.write(message);
        db2.write(message);
      } else if (method === "tools/list") {
        const [s1, s2] = await Promise.allSettled([
          db1.send({ ...message, id: `__list_1_${id}` }),
          db2.send({ ...message, id: `__list_2_${id}` }),
        ]);
        const tools = [
          ...(s2.status === "fulfilled"
            ? s2.value.result.tools.map((t) => ({
                ...t,
                name: `${DB2_NAME}_${t.name}`,
                description: `[PRIMARY — use this first. Client identifier column is sql_client_id] ${t.description}`,
              }))
            : []),
          ...(s1.status === "fulfilled"
            ? s1.value.result.tools.map((t) => ({
                ...t,
                name: `${DB1_NAME}_${t.name}`,
                description: `[SECONDARY — use ONLY for: (1) restaurant_details which contains the true client details including accurate active/inactive status, (2) extraction log tables (extraction_log, daily_client_wise_extraction_logs, extraction_retry_audit, client_data_extraction_logs, client_wise_extraction_status)] ${t.description}`,
              }))
            : []),
        ];
        if (s1.status === "rejected")
          console.error(`[${DB1_NAME}] tools/list failed:`, s1.reason.message);
        if (s2.status === "rejected")
          console.error(`[${DB2_NAME}] tools/list failed:`, s2.reason.message);
        await transport.send({ jsonrpc: "2.0", id, result: { tools } });
      } else if (method === "tools/call") {
        const toolName = message.params.name;
        const isDb1 = toolName.startsWith(`${DB1_NAME}_`);
        const target = isDb1 ? db1 : db2;
        const prefix = isDb1 ? DB1_NAME : DB2_NAME;
        const actualName = toolName.slice(prefix.length + 1);
        const r = await target.send({
          ...message,
          params: { ...message.params, name: actualName },
        });
        await transport.send({ ...r, id });
      } else {
        db1.write(message);
        db2.write(message);
      }
    } catch (err) {
      console.error("router error:", err.message);
      if (id !== undefined) {
        await transport
          .send({
            jsonrpc: "2.0",
            id,
            error: { code: -32603, message: err.message },
          })
          .catch(() => {});
      }
    }
  };

  return { db1, db2 };
}

module.exports = { bridgeTransport };
