const app = require("./src/app");
const { PORT } = require("./src/config");

app.listen(PORT, () => {
  console.log(`MCP Streamable HTTP server running on http://localhost:${PORT}/mcp`);
});
