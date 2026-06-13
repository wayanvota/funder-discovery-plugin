import readline from "node:readline";

const SERVER_NAME = "Kindora Funder Discovery Proxy";
const SERVER_VERSION = "0.1.0";
const UPSTREAM_URL = process.env.KINDORA_MCP_URL ?? "https://kindora-mcp.azurewebsites.net/mcp/";
const API_KEY = process.env.KINDORA_API_KEY;
const TIMEOUT_MS = Number.parseInt(process.env.KINDORA_TIMEOUT ?? "60000", 10);
const JsonRpcError = {
  METHOD_NOT_FOUND: -32601,
  INVALID_PARAMS: -32602,
  INTERNAL_ERROR: -32603,
};

const fallbackTools = [
  {
    name: "health_check",
    title: "Health Check",
    description: "Check that the upstream Kindora service is reachable and healthy.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    annotations: { readOnlyHint: true },
  },
  {
    name: "search_funders",
    title: "Search Grantmakers",
    description: "Find grantmaking organizations by name, cause area, or location.",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", description: "Funder name or cause-area phrase." },
        state: { type: "string", description: "Two-letter US state code for funder headquarters." },
        city: { type: "string", description: "City name for funder headquarters." },
        country: { type: "array", items: { type: "string" }, description: "Funder headquarters countries." },
        ntee_code: { type: "string", description: "NTEE classification code or prefix." },
        funder_type: { type: "string", description: "Foundation type filter." },
        exclude_funder_types: { type: "array", items: { type: "string" } },
        min_assets: { type: "integer" },
        max_assets: { type: "integer" },
        grantee_country_codes: { type: "array", items: { type: "string" } },
        has_er_grants: { type: "boolean" },
        limit: { type: "integer", minimum: 1, maximum: 50, default: 20 },
      },
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true },
  },
  {
    name: "search_open_grants",
    title: "Search Open Grants",
    description: "Find open grant opportunities and RFPs by topic or cause area.",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", description: "Natural-language topic or cause-area search." },
        focus_area: { type: "string" },
        state: { type: "string" },
        country: { type: "string" },
        source: { type: "string", enum: ["foundation", "government"] },
        nonprofit_only: { type: "boolean", default: true },
        min_award: { type: "integer" },
        max_award: { type: "integer" },
        deadline_days: { type: "integer", minimum: 1, maximum: 365, default: 90 },
        agency: { type: "string" },
        limit: { type: "integer", minimum: 1, maximum: 50, default: 20 },
      },
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true },
  },
  {
    name: "search_funder_jobs",
    title: "Search Funder Jobs",
    description: "Find open philanthropy jobs at grantmaking foundations.",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string" },
        category: { type: "string" },
        exclude_categories: { type: "array", items: { type: "string" } },
        funder_ein: { type: "string" },
        funder_eins: { type: "array", items: { type: "string" } },
        state: { type: "string" },
        country: { type: "string" },
        remote: { type: "string" },
        employment_type: { type: "string" },
        posted_within_days: { type: "integer", minimum: 0, maximum: 730, default: 365 },
        sort_by: { type: "string", enum: ["funder_giving", "recent"] },
        limit: { type: "integer", minimum: 1, maximum: 50, default: 20 },
      },
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true },
  },
  {
    name: "get_funder_profile",
    title: "Get Funder Profile",
    description: "Get a detailed profile for one foundation by EIN.",
    inputSchema: {
      type: "object",
      properties: { ein: { type: "string", description: "Foundation EIN, with or without hyphen." } },
      required: ["ein"],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true },
  },
  {
    name: "get_990_summary",
    title: "Get 990 Summary",
    description: "Get an IRS 990 or 990-PF financial summary and year-over-year trends for a foundation.",
    inputSchema: {
      type: "object",
      properties: {
        ein: { type: "string" },
        years: { type: "integer", minimum: 1, maximum: 10, default: 5 },
      },
      required: ["ein"],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true },
  },
  {
    name: "get_foundation_grants",
    title: "Get Foundation Grants",
    description: "List individual grants a foundation has made from its 990-PF filings.",
    inputSchema: {
      type: "object",
      properties: {
        ein: { type: "string" },
        year: { type: "integer" },
        ntee_code: { type: "string" },
        purpose_keyword: { type: "string" },
        recipient_state: { type: "string" },
        recipient_country: { type: "string" },
        limit: { type: "integer", minimum: 1, maximum: 50, default: 20 },
      },
      required: ["ein"],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true },
  },
  {
    name: "get_funder_stats",
    title: "Get Funder Stats",
    description: "Get aggregate giving statistics for a foundation.",
    inputSchema: {
      type: "object",
      properties: { ein: { type: "string" } },
      required: ["ein"],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true },
  },
  {
    name: "get_ntee_codes",
    title: "Get NTEE Codes",
    description: "Browse or search NTEE classification codes for cause areas.",
    inputSchema: {
      type: "object",
      properties: {
        category: { type: "string", description: "Single category letter A-Z." },
        query: { type: "string", description: "Search term against code descriptions." },
      },
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true },
  },
];

function send(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

function sendResult(id, result) {
  send({ jsonrpc: "2.0", id, result });
}

function sendError(id, code, message) {
  send({ jsonrpc: "2.0", id, error: { code, message } });
}

function parseSseOrJson(text) {
  const trimmed = text.trim();
  if (trimmed.startsWith("{")) {
    return JSON.parse(trimmed);
  }
  const dataLines = trimmed
    .split(/\r?\n/)
    .filter((line) => line.startsWith("data:"))
    .map((line) => line.slice(5).trim())
    .filter(Boolean);
  if (dataLines.length === 0) {
    throw new Error("Upstream response did not contain JSON or SSE data.");
  }
  return JSON.parse(dataLines.join("\n"));
}

async function callUpstream(method, params = {}, id = "kindora-proxy") {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), Number.isFinite(TIMEOUT_MS) ? TIMEOUT_MS : 60000);
  try {
    const headers = {
      "accept": "application/json, text/event-stream",
      "content-type": "application/json",
      "user-agent": "funder-discovery-plugin-kindora-proxy/0.1.0",
    };
    if (API_KEY) {
      headers.authorization = `Bearer ${API_KEY}`;
    }
    const response = await fetch(UPSTREAM_URL, {
      method: "POST",
      headers,
      body: JSON.stringify({ jsonrpc: "2.0", id, method, params }),
      signal: controller.signal,
    });
    const text = await response.text();
    if (!response.ok) {
      throw new Error(`Kindora upstream returned HTTP ${response.status}: ${text.slice(0, 300)}`);
    }
    const message = parseSseOrJson(text);
    if (message.error) {
      throw new Error(message.error.message ?? JSON.stringify(message.error));
    }
    return message.result;
  } finally {
    clearTimeout(timeout);
  }
}

function filterTools(tools) {
  return tools
    .filter((tool) => tool.name !== "list_tools")
    .map((tool) => ({
      ...tool,
      annotations: {
        ...(tool.annotations ?? {}),
        readOnlyHint: true,
      },
    }));
}

async function listTools() {
  try {
    const result = await callUpstream("tools/list", {}, "tools-list");
    if (Array.isArray(result?.tools) && result.tools.length > 0) {
      return filterTools(result.tools);
    }
  } catch {
    return fallbackTools;
  }
  return fallbackTools;
}

async function handleToolCall(id, params) {
  const name = params?.name;
  const allowed = new Set(fallbackTools.map((tool) => tool.name));
  if (!allowed.has(name)) {
    sendError(id, JsonRpcError.INVALID_PARAMS, `Unknown Kindora tool: ${name ?? ""}`);
    return;
  }
  const result = await callUpstream(
    "tools/call",
    { name, arguments: params.arguments ?? {} },
    `call-${name}-${Date.now()}`,
  );
  sendResult(id, result);
}

async function handleRequest(message) {
  const { id, method, params } = message;
  if (method === "initialize") {
    sendResult(id, {
      protocolVersion: params?.protocolVersion ?? "2025-11-25",
      capabilities: { tools: {} },
      serverInfo: { name: SERVER_NAME, version: SERVER_VERSION },
      instructions:
        "Use Kindora for read-only foundation prospect discovery: search funders, inspect funder profiles, analyze 990 summaries, review grants, calculate giving stats, search NTEE codes, and find open grant opportunities. Treat output as research leads and verify publication claims against filings or funder sources.",
    });
    return;
  }
  if (method === "ping") {
    sendResult(id, {});
    return;
  }
  if (method === "tools/list") {
    sendResult(id, { tools: await listTools() });
    return;
  }
  if (method === "tools/call") {
    try {
      await handleToolCall(id, params);
    } catch (error) {
      sendError(
        id,
        JsonRpcError.INTERNAL_ERROR,
        error instanceof Error ? error.message : String(error),
      );
    }
    return;
  }
  if (id !== undefined) {
    sendError(id, JsonRpcError.METHOD_NOT_FOUND, `Method not found: ${method}`);
  }
}

const lines = readline.createInterface({
  input: process.stdin,
  crlfDelay: Infinity,
});

lines.on("line", (line) => {
  if (line.trim().length === 0) {
    return;
  }
  let message;
  try {
    message = JSON.parse(line);
  } catch {
    return;
  }
  void handleRequest(message).catch((error) => {
    if (message.id !== undefined) {
      sendError(
        message.id,
        JsonRpcError.INTERNAL_ERROR,
        error instanceof Error ? error.message : String(error),
      );
    }
  });
});
