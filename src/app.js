const express = require("express");
const mcpRoutes = require("./routes/mcpRoutes");

const app = express();
app.use(express.json());
app.use(mcpRoutes);

module.exports = app;
