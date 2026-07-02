const express = require("express");
const { handlePost, handleSessionRequest } = require("../controllers/mcpController");

const router = express.Router();

router.post("/mcp", handlePost);
router.get("/mcp", handleSessionRequest);
router.delete("/mcp", handleSessionRequest);

module.exports = router;
