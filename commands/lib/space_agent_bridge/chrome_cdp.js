import fs from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";

const DEFAULT_DEVTOOLS_HOST = "127.0.0.1";
const DEFAULT_RUNTIME_WAIT_MS = 60000;
const DEFAULT_CHROME_START_WAIT_MS = 15000;

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function normalizeWindowsExecutablePath(value) {
  return value ? value.replace(/%([^%]+)%/g, (_, name) => process.env[name] || "") : "";
}

async function pathExists(filePath) {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

async function findChromeExecutable(explicitPath = "") {
  if (explicitPath) {
    if (!(await pathExists(explicitPath))) {
      throw new Error(`Browser executable not found: ${explicitPath}`);
    }
    return explicitPath;
  }

  const candidates =
    process.platform === "win32"
      ? [
          "%ProgramFiles%\\Google\\Chrome\\Application\\chrome.exe",
          "%ProgramFiles(x86)%\\Google\\Chrome\\Application\\chrome.exe",
          "%LocalAppData%\\Google\\Chrome\\Application\\chrome.exe",
          "%ProgramFiles%\\Microsoft\\Edge\\Application\\msedge.exe",
          "%ProgramFiles(x86)%\\Microsoft\\Edge\\Application\\msedge.exe",
          "%LocalAppData%\\Microsoft\\Edge\\Application\\msedge.exe"
        ].map(normalizeWindowsExecutablePath)
      : process.platform === "darwin"
        ? [
            "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
            "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
            "/Applications/Chromium.app/Contents/MacOS/Chromium"
          ]
        : ["google-chrome", "google-chrome-stable", "chromium", "chromium-browser", "microsoft-edge"];

  for (const candidate of candidates) {
    if (!candidate) {
      continue;
    }

    if (path.isAbsolute(candidate)) {
      if (await pathExists(candidate)) {
        return candidate;
      }
      continue;
    }

    return candidate;
  }

  throw new Error("Unable to find Chrome, Chromium, or Edge. Pass --browser <path>.");
}

function httpRequestJson(url, options = {}) {
  return new Promise((resolve, reject) => {
    const request = http.request(url, options, (response) => {
      const chunks = [];

      response.on("data", (chunk) => chunks.push(chunk));
      response.on("end", () => {
        const body = Buffer.concat(chunks).toString("utf8");
        if (response.statusCode < 200 || response.statusCode >= 300) {
          reject(new Error(`DevTools request failed with status ${response.statusCode}: ${body}`));
          return;
        }

        try {
          resolve(body ? JSON.parse(body) : {});
        } catch (error) {
          reject(new Error(`DevTools returned invalid JSON: ${error.message}`));
        }
      });
    });

    request.on("error", reject);
    request.end();
  });
}

export async function getBrowserWebSocketUrl(connectTarget) {
  const normalizedTarget = String(connectTarget || "").trim();
  if (!normalizedTarget) {
    throw new Error("A DevTools connect target is required.");
  }

  if (normalizedTarget.startsWith("ws://") || normalizedTarget.startsWith("wss://")) {
    return normalizedTarget;
  }

  const baseUrl = normalizedTarget.startsWith("http://") || normalizedTarget.startsWith("https://")
    ? normalizedTarget
    : `http://${normalizedTarget}`;
  const versionInfo = await httpRequestJson(new URL("/json/version", baseUrl));

  if (!versionInfo.webSocketDebuggerUrl) {
    throw new Error(`No browser DevTools WebSocket URL was exposed by ${baseUrl}.`);
  }

  return versionInfo.webSocketDebuggerUrl;
}

export async function launchChrome(options = {}) {
  const executable = await findChromeExecutable(options.browserPath);
  const userDataDir =
    options.userDataDir ||
    (await fs.mkdtemp(path.join(os.tmpdir(), "space-agent-bridge-profile-")));
  const chromeArgs = [
    "--remote-debugging-port=0",
    `--user-data-dir=${userDataDir}`,
    "--no-first-run",
    "--no-default-browser-check",
    "--disable-background-networking",
    "--disable-sync",
    "--disable-translate",
    "--disable-features=Translate",
    "about:blank"
  ];

  if (options.headless !== false) {
    chromeArgs.unshift("--headless=new", "--disable-gpu");
  }

  const child = spawn(executable, chromeArgs, {
    detached: false,
    stdio: ["ignore", "ignore", "pipe"]
  });

  let stderr = "";
  child.stderr?.on("data", (chunk) => {
    stderr += chunk.toString("utf8");
  });

  const activePortPath = path.join(userDataDir, "DevToolsActivePort");
  const startedAt = Date.now();

  while (Date.now() - startedAt < (options.startTimeoutMs || DEFAULT_CHROME_START_WAIT_MS)) {
    if (child.exitCode !== null) {
      throw new Error(`Browser exited before DevTools became available.${stderr ? `\n${stderr.trim()}` : ""}`);
    }

    try {
      const content = await fs.readFile(activePortPath, "utf8");
      const [portLine, wsPathLine] = content.trim().split(/\r?\n/u);
      const port = Number(portLine);
      if (Number.isInteger(port) && wsPathLine) {
        return {
          close: async () => {
            child.kill();
            if (!options.userDataDir) {
              try {
                await fs.rm(userDataDir, {
                  force: true,
                  maxRetries: 5,
                  recursive: true,
                  retryDelay: 150
                });
              } catch {
                // Browser profile cleanup is best-effort on Windows because Crashpad
                // can hold a file handle briefly after the browser exits.
              }
            }
          },
          process: child,
          userDataDir,
          webSocketUrl: `ws://${DEFAULT_DEVTOOLS_HOST}:${port}${wsPathLine}`
        };
      }
    } catch {
      // DevToolsActivePort is created asynchronously by Chromium.
    }

    await delay(100);
  }

  child.kill();
  throw new Error(`Timed out waiting for browser DevTools.${stderr ? `\n${stderr.trim()}` : ""}`);
}

export class CdpConnection {
  constructor(webSocketUrl) {
    this.nextId = 1;
    this.pending = new Map();
    this.webSocketUrl = webSocketUrl;
    this.ws = null;
  }

  async connect() {
    this.ws = new WebSocket(this.webSocketUrl);

    await new Promise((resolve, reject) => {
      const cleanup = () => {
        this.ws.removeEventListener("open", handleOpen);
        this.ws.removeEventListener("error", handleError);
      };
      const handleOpen = () => {
        cleanup();
        resolve();
      };
      const handleError = (event) => {
        cleanup();
        reject(new Error(`Unable to connect to DevTools WebSocket: ${event.message || "connection failed"}`));
      };

      this.ws.addEventListener("open", handleOpen, { once: true });
      this.ws.addEventListener("error", handleError, { once: true });
    });

    this.ws.addEventListener("message", (event) => this.handleMessage(event));
    this.ws.addEventListener("close", () => {
      for (const { reject } of this.pending.values()) {
        reject(new Error("DevTools WebSocket closed."));
      }
      this.pending.clear();
    });
  }

  handleMessage(event) {
    const message = JSON.parse(event.data);
    if (!message.id || !this.pending.has(message.id)) {
      return;
    }

    const pending = this.pending.get(message.id);
    this.pending.delete(message.id);

    if (message.error) {
      pending.reject(new Error(message.error.message || JSON.stringify(message.error)));
      return;
    }

    pending.resolve(message.result || {});
  }

  send(method, params = {}, sessionId = "") {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      throw new Error("DevTools WebSocket is not open.");
    }

    const id = this.nextId++;
    const payload = { id, method, params };
    if (sessionId) {
      payload.sessionId = sessionId;
    }

    const promise = new Promise((resolve, reject) => {
      this.pending.set(id, { reject, resolve });
    });

    this.ws.send(JSON.stringify(payload));
    return promise;
  }

  close() {
    this.ws?.close();
  }
}

export async function createPageSession(connection, url, options = {}) {
  const target = await connection.send("Target.createTarget", { url: "about:blank" });
  const attached = await connection.send("Target.attachToTarget", {
    flatten: true,
    targetId: target.targetId
  });
  const sessionId = attached.sessionId;

  await connection.send("Runtime.enable", {}, sessionId);
  await connection.send("Page.enable", {}, sessionId);
  await connection.send(
    "Page.addScriptToEvaluateOnNewDocument",
    {
      source: `
        try {
          window.sessionStorage.setItem("space.enter.tab-access", "1");
        } catch {}
      `
    },
    sessionId
  );
  await connection.send("Page.navigate", { url }, sessionId);
  await waitForExpression(
    connection,
    sessionId,
    `
      Boolean(
        globalThis.space &&
        globalThis.space.onscreenAgent &&
        typeof globalThis.space.onscreenAgent.submitPrompt === "function" &&
        globalThis.Alpine &&
        globalThis.Alpine.store &&
        globalThis.Alpine.store("onscreenAgent")
      )
    `,
    {
      intervalMs: 250,
      timeoutMs: options.runtimeWaitMs || DEFAULT_RUNTIME_WAIT_MS
    }
  );

  return sessionId;
}

export async function evaluate(connection, sessionId, expression, options = {}) {
  const result = await connection.send(
    "Runtime.evaluate",
    {
      awaitPromise: options.awaitPromise !== false,
      expression,
      returnByValue: true,
      timeout: options.timeoutMs
    },
    sessionId
  );

  if (result.exceptionDetails) {
    const description = result.exceptionDetails.exception?.description || result.exceptionDetails.text;
    throw new Error(description || "Browser evaluation failed.");
  }

  return result.result?.value;
}

export async function waitForExpression(connection, sessionId, expression, options = {}) {
  const startedAt = Date.now();
  const timeoutMs = options.timeoutMs || DEFAULT_RUNTIME_WAIT_MS;
  const intervalMs = options.intervalMs || 250;
  let lastError = null;

  while (Date.now() - startedAt < timeoutMs) {
    try {
      if (await evaluate(connection, sessionId, expression, { awaitPromise: false })) {
        return true;
      }
    } catch (error) {
      lastError = error;
    }

    await delay(intervalMs);
  }

  throw new Error(
    `Timed out waiting for Space Agent runtime.${lastError ? ` Last error: ${lastError.message}` : ""}`
  );
}
