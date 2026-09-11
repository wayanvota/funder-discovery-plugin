import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import http from "node:http";
import { once } from "node:events";
import { fileURLToPath } from "node:url";
import path from "node:path";
import test, { after, before } from "node:test";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const FIXTURE_SECRET = "fixture-upstream-secret-must-not-escape";
const FIXTURE_KEY = "fixture-kindora-key-must-not-escape";
const KINDORA_TOOL_NAMES = [
  "health_check",
  "search_funders",
  "search_open_grants",
  "search_funder_jobs",
  "get_funder_profile",
  "get_990_summary",
  "get_foundation_grants",
  "get_funder_stats",
  "get_ntee_codes",
];

let requestId = 0;
let fixtureServer;
let fixtureUrl;
let propublica;
let kindora;
let actions;
let actionsUrl;
let kindoraSawAuthorization = false;

function jsonResponse(res, status, payload) {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(payload));
}

async function readRequest(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  return Buffer.concat(chunks).toString("utf8");
}

function fixtureTools() {
  return [
    ...KINDORA_TOOL_NAMES.map((name) => ({
      name,
      description: `Fixture schema for ${name}`,
      inputSchema: { type: "object", properties: {}, additionalProperties: true },
      annotations: { readOnlyHint: true },
    })),
    {
      name: "list_tools",
      description: "Redundant upstream helper",
      inputSchema: { type: "object", properties: {} },
    },
    {
      name: "unreviewed_write_tool",
      description: "Fixture for upstream tool-surface drift",
      inputSchema: { type: "object", properties: {} },
    },
  ];
}

async function handleFixture(req, res) {
  const url = new URL(req.url, "http://fixture.invalid");
  if (req.method === "GET" && url.pathname.endsWith("/search.json")) {
    return jsonResponse(res, 200, {
      organizations: [
        { ein: 111111111, name: "North Carolina Health Fund", state: "NC", ntee_code: "E20" },
        { ein: 222222222, name: "New York Arts Fund", state: "NY", ntee_code: "A20" },
      ],
    });
  }
  if (req.method === "GET" && url.pathname.endsWith("/organizations/111111111.json")) {
    return jsonResponse(res, 200, {
      organization: { ein: 111111111, name: "North Carolina Health Fund", state: "NC" },
      filings_with_data: [{ tax_prd_yr: 2025, xml_url: `${fixtureUrl}/filing.xml`, totgivinggrnts: 250000 }],
      filings_without_data: [],
    });
  }
  if (req.method === "GET" && url.pathname === "/filing.xml") {
    res.writeHead(200, { "content-type": "application/xml" });
    return res.end(`<Return>${"x".repeat(1400)}</Return>`);
  }
  if (req.method === "POST" && url.pathname === "/kindora") {
    kindoraSawAuthorization ||= req.headers.authorization === `Bearer ${FIXTURE_KEY}`;
    const body = JSON.parse(await readRequest(req));
    if (body.method === "tools/list") {
      return jsonResponse(res, 200, { jsonrpc: "2.0", id: body.id, result: { tools: fixtureTools() } });
    }
    if (body.method === "tools/call") {
      if (body.params?.arguments?.query === "__ERROR__") {
        return jsonResponse(res, 200, {
          jsonrpc: "2.0",
          id: body.id,
          error: { code: -32603, message: FIXTURE_SECRET },
        });
      }
      const structuredContent = {
        fixture: true,
        name: body.params?.name,
        arguments: body.params?.arguments ?? {},
      };
      return jsonResponse(res, 200, {
        jsonrpc: "2.0",
        id: body.id,
        result: {
          content: [{ type: "text", text: JSON.stringify(structuredContent) }],
          structuredContent,
        },
      });
    }
  }
  return jsonResponse(res, 404, { error: "not_found" });
}

class McpProcess {
  constructor(script, env = {}) {
    this.pending = new Map();
    this.stdout = "";
    this.stderr = "";
    this.buffer = "";
    this.child = spawn(process.execPath, [script], {
      cwd: ROOT,
      env,
      stdio: ["pipe", "pipe", "pipe"],
    });
    this.child.stdout.on("data", (chunk) => this.#onStdout(chunk));
    this.child.stderr.on("data", (chunk) => { this.stderr += chunk.toString(); });
    this.child.on("exit", (code) => {
      for (const { reject, timer } of this.pending.values()) {
        clearTimeout(timer);
        reject(new Error(`MCP process exited with ${code}. stderr: ${this.stderr}`));
      }
      this.pending.clear();
    });
  }

  #onStdout(chunk) {
    const text = chunk.toString();
    this.stdout += text;
    this.buffer += text;
    while (this.buffer.includes("\n")) {
      const index = this.buffer.indexOf("\n");
      const line = this.buffer.slice(0, index).trim();
      this.buffer = this.buffer.slice(index + 1);
      if (!line) continue;
      const message = JSON.parse(line);
      const pending = this.pending.get(String(message.id));
      if (pending) {
        clearTimeout(pending.timer);
        this.pending.delete(String(message.id));
        pending.resolve(message);
      }
    }
  }

  sendRaw(line) {
    this.child.stdin.write(`${line}\n`);
  }

  request(method, params = {}) {
    const id = ++requestId;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(String(id));
        reject(new Error(`Timed out waiting for ${method}. stderr: ${this.stderr}`));
      }, 4000);
      this.pending.set(String(id), { resolve, reject, timer });
      this.sendRaw(JSON.stringify({ jsonrpc: "2.0", id, method, params }));
    });
  }

  async initialize() {
    return this.request("initialize", {
      protocolVersion: "2025-11-25",
      capabilities: {},
      clientInfo: { name: "e2e-harness", version: "1.0.0" },
    });
  }

  async close() {
    if (this.child.exitCode !== null) return;
    this.child.stdin.end();
    await Promise.race([
      once(this.child, "exit"),
      new Promise((resolve) => setTimeout(resolve, 1000)),
    ]);
    if (this.child.exitCode === null) this.child.kill("SIGTERM");
  }
}

async function unusedPort() {
  const server = http.createServer();
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const { port } = server.address();
  server.close();
  await once(server, "close");
  return port;
}

async function waitForHttp(url) {
  for (let attempt = 0; attempt < 60; attempt += 1) {
    try {
      const response = await fetch(url);
      if (response.ok) return;
    } catch {
      // The subprocess may still be binding its socket.
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`HTTP service did not start: ${url}`);
}

async function callTool(client, name, args = {}) {
  return client.request("tools/call", { name, arguments: args });
}

before(async () => {
  fixtureServer = http.createServer((req, res) => {
    void handleFixture(req, res).catch((error) => jsonResponse(res, 500, { error: error.message }));
  });
  fixtureServer.listen(0, "127.0.0.1");
  await once(fixtureServer, "listening");
  fixtureUrl = `http://127.0.0.1:${fixtureServer.address().port}`;

  propublica = new McpProcess("mcp/server.mjs", {
    PROPUBLICA_BASE_URL: `${fixtureUrl}/propublica/api/v2`,
    PROPUBLICA_ALLOWED_XML_HOSTS: "127.0.0.1",
    PROPUBLICA_ALLOW_TEST_HTTP: "1",
  });
  kindora = new McpProcess("mcp/kindora-server.mjs", {
    KINDORA_MCP_URL: `${fixtureUrl}/kindora`,
    KINDORA_API_KEY: FIXTURE_KEY,
    KINDORA_TIMEOUT: "2000",
  });

  const port = await unusedPort();
  actionsUrl = `http://127.0.0.1:${port}`;
  actions = spawn(process.execPath, ["actions/action-server.mjs"], {
    cwd: ROOT,
    env: { PORT: String(port), PUBLIC_BASE_URL: actionsUrl, FUNDER_DISCOVERY_MOCK: "1" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  actions.stdoutText = "";
  actions.stderrText = "";
  actions.stdout.on("data", (chunk) => { actions.stdoutText += chunk.toString(); });
  actions.stderr.on("data", (chunk) => { actions.stderrText += chunk.toString(); });
  await waitForHttp(`${actionsUrl}/health`);
});

after(async () => {
  await Promise.all([propublica?.close(), kindora?.close()]);
  if (actions && actions.exitCode === null) {
    actions.kill("SIGTERM");
    await Promise.race([once(actions, "exit"), new Promise((resolve) => setTimeout(resolve, 1000))]);
  }
  if (fixtureServer?.listening) {
    fixtureServer.close();
    await once(fixtureServer, "close");
  }
});

test("U01 ProPublica subprocess completes MCP initialization", async () => {
  const response = await propublica.initialize();
  assert.equal(response.result.serverInfo.name, "ProPublica 990 Lookup");
  assert.equal(response.result.protocolVersion, "2025-11-25");
});

test("U02 ProPublica discovery exposes four read-only tools", async () => {
  const response = await propublica.request("tools/list");
  assert.deepEqual(response.result.tools.map((tool) => tool.name), [
    "search_nonprofits", "get_organization", "get_foundation_filings", "get_filing_xml",
  ]);
  assert.ok(response.result.tools.every((tool) => tool.annotations.readOnlyHint));
});

test("U03 ProPublica search crosses the stdio and HTTP boundaries", async () => {
  const response = await callTool(propublica, "search_nonprofits", { q: "health", state: "nc", limit: 1 });
  assert.equal(response.result.structuredContent.count, 1);
  assert.equal(response.result.structuredContent.results[0].name, "North Carolina Health Fund");
});

test("U04 ProPublica organization lookup normalizes an EIN", async () => {
  const response = await callTool(propublica, "get_organization", { ein: "11-1111111" });
  assert.equal(response.result.structuredContent.organization.ein, 111111111);
  assert.equal(response.result.structuredContent.filings_with_data[0].tax_prd_yr, 2025);
});

test("U05 ProPublica filing XML is fetched and capped", async () => {
  const response = await callTool(propublica, "get_filing_xml", {
    xml_url: `${fixtureUrl}/filing.xml`, max_chars: 1000,
  });
  assert.equal(response.result.structuredContent.returned_chars, 1000);
  assert.equal(response.result.structuredContent.truncated, true);
});

test("U06 Kindora subprocess completes MCP initialization", async () => {
  const response = await kindora.initialize();
  assert.equal(response.result.serverInfo.name, "Kindora Funder Discovery Proxy");
});

test("U07 Kindora discovery exposes nine read-only tools", async () => {
  const response = await kindora.request("tools/list");
  assert.deepEqual(response.result.tools.map((tool) => tool.name), KINDORA_TOOL_NAMES);
  assert.ok(response.result.tools.every((tool) => tool.annotations.readOnlyHint));
  assert.equal(kindoraSawAuthorization, true, JSON.stringify({ response, stderr: kindora.stderr }));
});

test("U08 Kindora tool calls reach the configured upstream", async () => {
  const response = await callTool(kindora, "search_funders", { query: "community health", state: "NC", limit: 5 });
  assert.ok(response.result, JSON.stringify({ response, stderr: kindora.stderr }));
  assert.deepEqual(response.result.structuredContent, {
    fixture: true,
    name: "search_funders",
    arguments: { query: "community health", state: "NC", limit: 5 },
  });
});

test("U09 Actions subprocess serves health and OpenAPI", async () => {
  const health = await fetch(`${actionsUrl}/health`).then((response) => response.json());
  const openapi = await fetch(`${actionsUrl}/openapi.json`).then((response) => response.json());
  assert.equal(health.status, "ok");
  assert.equal(health.mockMode, true);
  assert.equal(openapi.servers[0].url, actionsUrl);
  assert.ok(openapi.paths["/api/funder-discovery/run"]);
});

test("U10 Actions completes a mock discovery workflow", async () => {
  const response = await fetch(`${actionsUrl}/api/funder-discovery/run`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      organizationProfile: {
        organizationName: "Youth Pathways",
        mission: "Help low-income young adults build career pathways into living-wage work.",
        programsOrFundingNeeds: "Youth workforce training, mentoring, and digital skills program expansion.",
        geographyServed: "New York City",
        beneficiaries: "Low-income young adults ages 18 to 24.",
        desiredGrantSize: { min: 50000, max: 150000 },
        fundingType: "Program support",
        evidenceOfResults: "78 percent job placement within six months for recent cohorts.",
        relationshipAssets: ["board member connected to workforce funders"],
      },
      options: { shortlistSize: 3, mockMode: true },
    }),
  });
  const data = await response.json();
  assert.equal(response.status, 200);
  assert.ok(["complete", "partial"].includes(data.status));
  assert.ok(data.prospects.length > 0);
  assert.ok(data.downloadLinks.csv && data.downloadLinks.xlsx && data.downloadLinks.markdown);
});

test("A01 malformed MCP input is ignored without killing the process", async () => {
  propublica.sendRaw("{not-json");
  const response = await propublica.request("ping");
  assert.deepEqual(response.result, {});
});

test("A02 unknown MCP methods receive method-not-found", async () => {
  const response = await propublica.request("filesystem/delete", {});
  assert.equal(response.error.code, -32601);
});

test("A03 unknown MCP tools are rejected", async () => {
  const response = await callTool(propublica, "delete_everything", {});
  assert.equal(response.error.code, -32602);
});

test("A04 malformed EINs are rejected before an upstream request", async () => {
  const response = await callTool(propublica, "get_organization", { ein: "not-an-ein" });
  assert.equal(response.error.code, -32602);
  assert.match(response.error.message, /9 digits/);
});

test("A05 oversized search text is rejected", async () => {
  const response = await callTool(propublica, "search_nonprofits", { q: "x".repeat(501) });
  assert.equal(response.error.code, -32602);
  assert.match(response.error.message, /500 characters/);
});

test("A06 filing XML rejects an unapproved host", async () => {
  const response = await callTool(propublica, "get_filing_xml", { xml_url: "https://localhost/private.xml" });
  assert.equal(response.error.code, -32602);
  assert.match(response.error.message, /approved/);
});

test("A07 Kindora rejects out-of-range arguments locally", async () => {
  const response = await callTool(kindora, "search_funders", { query: "health", limit: 5000 });
  assert.equal(response.error.code, -32602);
  assert.match(response.error.message, /documented range/);
});

test("A08 Kindora returns a generic, secret-safe upstream failure", async () => {
  const response = await callTool(kindora, "search_funders", { query: "__ERROR__" });
  assert.equal(response.error.code, -32603);
  assert.equal(response.error.message, "Kindora could not complete the request. Try again later.");
  assert.doesNotMatch(JSON.stringify(response), new RegExp(FIXTURE_SECRET));
});

test("A09 Actions rejects malformed JSON as a client error", async () => {
  const response = await fetch(`${actionsUrl}/api/intake/check`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: "{invalid-json",
  });
  const data = await response.json();
  assert.equal(response.status, 400);
  assert.equal(data.error, "invalid_json");
});

test("A10 Actions bounds request bodies and all process output stays secret-safe", async () => {
  const response = await fetch(`${actionsUrl}/api/intake/check`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ padding: "x".repeat((1024 * 1024) + 1) }),
  });
  assert.equal(response.status, 413);
  const output = [propublica.stdout, propublica.stderr, kindora.stdout, kindora.stderr, actions.stdoutText, actions.stderrText].join("\n");
  assert.doesNotMatch(output, new RegExp(FIXTURE_KEY));
  assert.doesNotMatch(output, new RegExp(FIXTURE_SECRET));
});
