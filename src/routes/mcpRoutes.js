const express = require("express");
const { handlePost, methodNotAllowed } = require("../controllers/mcpController");

const router = express.Router();

router.post("/mcp", handlePost);
router.get("/mcp", methodNotAllowed);
router.delete("/mcp", methodNotAllowed);

module.exports = router;
