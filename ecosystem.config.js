module.exports = {
  apps: [
    {
      name: "voosh-db-mcp",
      script: "index.js",
      // fork mode with a single instance is REQUIRED here, not a default.
      // Sessions (and their two MySQL child processes) live in this process's
      // in-memory Map, keyed by mcp-session-id. Cluster mode would round-robin
      // requests across workers, so follow-up calls would land on a worker that
      // never opened the session — every session would break. Do not switch to
      // cluster / instances > 1 unless the session store is moved out of process.
      exec_mode: "fork",
      instances: 1,
      autorestart: true,
      // No max_memory_restart on purpose: a restart kills every live session
      // and its children. Leave memory unbounded so long-running sessions survive.
      // Keep spawned MCP children headless — no cmd windows on Windows.
      windowsHide: true,
      env: {
        NODE_ENV: "production",
      },
    },
  ],
};
