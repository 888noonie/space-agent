import {
  CdpConnection,
  createPageSession,
  evaluate,
  getBrowserWebSocketUrl,
  launchChrome
} from "./lib/space_agent_bridge/chrome_cdp.js";

const DEFAULT_SPACE_URL = "http://127.0.0.1:8888/#/spaces?id=space-2";
const DEFAULT_TIMEOUT_MS = 10 * 60 * 1000;

function createUsageError(message) {
  const error = new Error(message);
  error.code = "ERR_BRIDGE_USAGE";
  return error;
}

function parseBooleanFlagValue(rawValue, flagName) {
  if (rawValue === undefined || rawValue === "") {
    return true;
  }

  const normalizedValue = String(rawValue).trim().toLowerCase();
  if (["1", "true", "yes", "on"].includes(normalizedValue)) {
    return true;
  }
  if (["0", "false", "no", "off"].includes(normalizedValue)) {
    return false;
  }

  throw createUsageError(`Invalid boolean value for ${flagName}: ${rawValue}`);
}

function readOptionValue(args, index, flagName) {
  const current = args[index];
  const equalsIndex = current.indexOf("=");
  if (equalsIndex !== -1) {
    return {
      nextIndex: index,
      value: current.slice(equalsIndex + 1)
    };
  }

  const value = args[index + 1];
  if (!value || value.startsWith("--")) {
    throw createUsageError(`${flagName} requires a value.`);
  }

  return {
    nextIndex: index + 1,
    value
  };
}

function parseBridgeArgs(args = []) {
  const options = {
    browserPath: process.env.SPACE_BRIDGE_BROWSER || "",
    connect: process.env.SPACE_BRIDGE_CONNECT || "",
    headless: process.env.SPACE_BRIDGE_HEADLESS
      ? parseBooleanFlagValue(process.env.SPACE_BRIDGE_HEADLESS, "SPACE_BRIDGE_HEADLESS")
      : true,
    json: false,
    keepBrowser: false,
    mode: "compact",
    prompt: "",
    timeoutMs: DEFAULT_TIMEOUT_MS,
    url: process.env.SPACE_BRIDGE_URL || DEFAULT_SPACE_URL,
    userDataDir: process.env.SPACE_BRIDGE_USER_DATA_DIR || ""
  };
  const promptParts = [];

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];

    if (arg === "send" && promptParts.length === 0) {
      continue;
    }

    if (!arg.startsWith("--")) {
      promptParts.push(arg);
      continue;
    }

    if (arg === "--json") {
      options.json = true;
      continue;
    }

    if (arg === "--headed") {
      options.headless = false;
      continue;
    }

    if (arg === "--headless") {
      options.headless = true;
      continue;
    }

    if (arg === "--keep-browser") {
      options.keepBrowser = true;
      continue;
    }

    if (arg.startsWith("--url")) {
      const { nextIndex, value } = readOptionValue(args, index, "--url");
      options.url = value;
      index = nextIndex;
      continue;
    }

    if (arg.startsWith("--connect")) {
      const { nextIndex, value } = readOptionValue(args, index, "--connect");
      options.connect = value;
      index = nextIndex;
      continue;
    }

    if (arg.startsWith("--browser")) {
      const { nextIndex, value } = readOptionValue(args, index, "--browser");
      options.browserPath = value;
      index = nextIndex;
      continue;
    }

    if (arg.startsWith("--user-data-dir")) {
      const { nextIndex, value } = readOptionValue(args, index, "--user-data-dir");
      options.userDataDir = value;
      index = nextIndex;
      continue;
    }

    if (arg.startsWith("--timeout")) {
      const { nextIndex, value } = readOptionValue(args, index, "--timeout");
      const timeoutMs = Number(value);
      if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
        throw createUsageError(`Invalid timeout: ${value}`);
      }
      options.timeoutMs = Math.floor(timeoutMs);
      index = nextIndex;
      continue;
    }

    if (arg.startsWith("--mode")) {
      const { nextIndex, value } = readOptionValue(args, index, "--mode");
      if (!["compact", "full"].includes(value)) {
        throw createUsageError("--mode must be compact or full.");
      }
      options.mode = value;
      index = nextIndex;
      continue;
    }

    throw createUsageError(`Unknown option: ${arg}`);
  }

  options.prompt = promptParts.join(" ").trim();
  if (!options.prompt) {
    throw createUsageError("A prompt is required.");
  }

  return options;
}

function buildPromptExpression(prompt, options = {}) {
  return `
    (async () => {
      const store = globalThis.Alpine?.store?.("onscreenAgent");
      if (!globalThis.space?.onscreenAgent?.submitPrompt || !store) {
        throw new Error("The onscreen agent runtime is not ready.");
      }

      await store.init?.();
      const startIndex = Array.isArray(store.history) ? store.history.length : 0;
      const startedAt = new Date().toISOString();
      const submission = await globalThis.space.onscreenAgent.submitPrompt(${JSON.stringify(prompt)}, {
        focusInput: false,
        hideBubble: true,
        mode: ${JSON.stringify(options.mode || "compact")},
        persist: true
      });
      const history = Array.isArray(store.history) ? store.history : [];
      const messages = history.slice(startIndex).map((message) => ({
        content: String(message?.content || ""),
        id: String(message?.id || ""),
        kind: String(message?.kind || ""),
        role: String(message?.role || "")
      }));
      const responseMessages = [];
      for (const [index, message] of messages.entries()) {
        if (index > 0 && message.role === "user" && message.kind !== "execution-output") {
          break;
        }
        responseMessages.push(message);
      }
      const assistantMessages = responseMessages.filter((message) => message.role === "assistant");
      const finalAssistant = assistantMessages.length ? assistantMessages[assistantMessages.length - 1] : null;

      return JSON.stringify({
        finalAssistant,
        messages,
        ok: true,
        responseMessages,
        status: String(store.status || ""),
        submission,
        title: document.title,
        url: location.href,
        startedAt,
        completedAt: new Date().toISOString()
      });
    })()
  `;
}

function formatTextResult(result) {
  const text = result?.finalAssistant?.content?.trim();
  if (text) {
    return text;
  }

  const fallback = result?.messages
    ?.map((message) => `${message.role}${message.kind ? `/${message.kind}` : ""}: ${message.content}`.trim())
    .filter(Boolean)
    .join("\n\n");

  return fallback || "Space Agent completed without returning assistant text.";
}

export async function execute(context = {}) {
  const options = parseBridgeArgs(context.args);
  let launchedBrowser = null;
  let connection = null;

  try {
    const webSocketUrl = options.connect
      ? await getBrowserWebSocketUrl(options.connect)
      : (launchedBrowser = await launchChrome({
          browserPath: options.browserPath,
          headless: options.headless,
          userDataDir: options.userDataDir
        })).webSocketUrl;

    connection = new CdpConnection(webSocketUrl);
    await connection.connect();

    const sessionId = await createPageSession(connection, options.url, {
      runtimeWaitMs: Math.min(options.timeoutMs, 120000)
    });
    const rawResult = await evaluate(connection, sessionId, buildPromptExpression(options.prompt, options), {
      timeoutMs: options.timeoutMs
    });
    const result = JSON.parse(rawResult);

    if (options.json) {
      console.log(JSON.stringify(result, null, 2));
    } else {
      console.log(formatTextResult(result));
    }

    return 0;
  } finally {
    connection?.close();
    if (launchedBrowser && !options.keepBrowser) {
      await launchedBrowser.close();
    }
  }
}

export const help = {
  name: "bridge",
  summary: "Send a terminal prompt to the live browser Space Agent.",
  usage: "node space bridge [send] <prompt> [--url <url>] [--connect <host:port|ws-url>] [--json]",
  description:
    "Opens or connects to a Chromium DevTools session, loads the Space Agent app, submits a prompt through the browser-owned onscreen agent runtime, waits for completion, and prints the response.",
  arguments: [
    {
      name: "prompt",
      description: "Task or message to send to Space Agent."
    }
  ],
  options: [
    {
      flag: "--url <url>",
      description: `Space Agent app URL to open. Defaults to ${DEFAULT_SPACE_URL}.`
    },
    {
      flag: "--connect <host:port|ws-url>",
      description: "Use an existing browser with DevTools enabled instead of launching a temporary browser."
    },
    {
      flag: "--browser <path>",
      description: "Path to Chrome, Chromium, or Edge when auto-discovery is insufficient."
    },
    {
      flag: "--user-data-dir <path>",
      description: "Browser profile directory to reuse for launched bridge sessions."
    },
    {
      flag: "--headed",
      description: "Launch a visible browser window instead of headless Chromium."
    },
    {
      flag: "--keep-browser",
      description: "Leave a launched browser running after the command completes."
    },
    {
      flag: "--timeout <ms>",
      description: `Maximum prompt wait time. Defaults to ${DEFAULT_TIMEOUT_MS}.`
    },
    {
      flag: "--mode <compact|full>",
      description: "Overlay display mode to request before sending the prompt."
    },
    {
      flag: "--json",
      description: "Print structured response messages instead of only the final assistant reply."
    }
  ],
  examples: [
    'node space bridge "Summarize the current Slippy space."',
    'node space bridge send "Inspect the Frog Runner widget and tell me whether it loads." --json',
    'node space bridge "What files can you see?" --url http://127.0.0.1:8888/#/spaces?id=space-2',
    'node space bridge "Continue the current task" --connect 127.0.0.1:9222'
  ]
};
