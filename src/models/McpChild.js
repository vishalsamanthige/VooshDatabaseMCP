const { spawn } = require("child_process");
const path = require("path");

const { REQUEST_TIMEOUT_MS } = require("../config");

// Resolve the mcp-server-mysql executable script ONCE at load time so we can run
// it directly with the current `node` binary. This deliberately avoids `npx` and
// `shell: true`: under PM2 (especially on Windows) spawning through a shell/npx
// pops up visible cmd windows for every child. Running the script with
// `process.execPath` + `windowsHide: true` keeps every child headless.
function resolveServerBin() {
  const pkgJsonPath = require.resolve("@benborla29/mcp-server-mysql/package.json");
  const pkgDir = path.dirname(pkgJsonPath);
  const pkg = require(pkgJsonPath);

  let binRel;
  if (typeof pkg.bin === "string") {
    binRel = pkg.bin;
  } else if (pkg.bin && pkg.bin["mcp-server-mysql"]) {
    binRel = pkg.bin["mcp-server-mysql"];
  } else if (pkg.bin) {
    binRel = Object.values(pkg.bin)[0];
  } else {
    binRel = pkg.main;
  }

  return path.join(pkgDir, binRel);
}

const SERVER_BIN = resolveServerBin();

// Wraps a single MCP child process, translating stdout JSON-RPC lines into
// resolved promises keyed by request id.
class McpChild {
  constructor(envOverrides, label) {
    this.label = label;
    this.pending = new Map();
    this.buffer = "";

    this.child = spawn(process.execPath, [SERVER_BIN], {
      env: { ...process.env, ...envOverrides },
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true, // never surface a console window (PM2-friendly)
    });

    this._wire();
  }

  _wire() {
    this.child.stdout.on("data", (data) => {
      this.buffer += data.toString();
      const lines = this.buffer.split("\n");
      this.buffer = lines.pop();
      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        let parsed;
        try {
          parsed = JSON.parse(trimmed);
        } catch {
          continue;
        }
        const id = parsed.id;
        if (id !== undefined && this.pending.has(id)) {
          const resolve = this.pending.get(id);
          this.pending.delete(id);
          resolve(parsed);
        }
      }
    });

    this.child.stdin.on("error", (err) =>
      console.error(`[${this.label}] stdin error:`, err.code)
    );
    this.child.stderr.on("data", (d) =>
      console.error(`[${this.label}] ERR:`, d.toString().trim())
    );
    this.child.on("error", (err) =>
      console.error(`[${this.label}] spawn error:`, err)
    );
    this.child.on("exit", (code, sig) =>
      console.error(`[${this.label}] exited code=${code} sig=${sig}`)
    );
  }

  // Send a JSON-RPC message. Resolves with the matching response when the
  // message carries an id; resolves immediately (null) for notifications.
  send(message) {
    return new Promise((resolve, reject) => {
      if (message.id !== undefined) {
        this.pending.set(message.id, resolve);
        setTimeout(() => {
          if (this.pending.has(message.id)) {
            this.pending.delete(message.id);
            reject(new Error(`[${this.label}] timeout for id=${message.id}`));
          }
        }, REQUEST_TIMEOUT_MS);
      }
      try {
        this.child.stdin.write(JSON.stringify(message) + "\n");
      } catch (err) {
        if (message.id !== undefined) this.pending.delete(message.id);
        return reject(err);
      }
      if (message.id === undefined) resolve(null);
    });
  }

  // Fire-and-forget raw write (used for notifications). Never throws.
  write(message) {
    try {
      this.child.stdin.write(JSON.stringify(message) + "\n");
    } catch {
      /* child gone — ignore */
    }
  }

  kill() {
    this.child.kill();
  }
}

module.exports = McpChild;
