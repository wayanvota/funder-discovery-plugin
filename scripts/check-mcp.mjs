import { spawn } from "node:child_process";

const root = new URL("..", import.meta.url);

async function listTools(scriptPath) {
  const child = spawn(process.execPath, [scriptPath], {
    cwd: root,
    stdio: ["pipe", "pipe", "pipe"],
  });

  let output = "";
  child.stdout.on("data", (chunk) => {
    output += chunk.toString();
  });

  child.stderr.on("data", (chunk) => {
    process.stderr.write(chunk);
  });

  function send(message) {
    child.stdin.write(`${JSON.stringify(message)}\n`);
  }

  send({
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
    params: { protocolVersion: "2025-11-25" },
  });
  send({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} });

  await new Promise((resolve) => setTimeout(resolve, 750));
  child.kill();
  const lines = output.trim().split("\n").filter(Boolean).map((line) => JSON.parse(line));
  return lines.find((line) => line.id === 2)?.result?.tools ?? [];
}

function assertTools(label, toolList, required) {
  const toolNames = toolList.map((tool) => tool.name);
  const missing = required.filter((name) => !toolNames.includes(name));
  if (missing.length > 0) {
    console.error(`${label} missing tools: ${missing.join(", ")}`);
    process.exit(1);
  }
  console.log(`${label} MCP check passed: ${toolNames.join(", ")}`);
}

const propublicaTools = await listTools("mcp/server.mjs");
assertTools("ProPublica", propublicaTools, [
  "search_nonprofits",
  "get_organization",
  "get_foundation_filings",
  "get_filing_xml",
]);

const kindoraTools = await listTools("mcp/kindora-server.mjs");
assertTools("Kindora", kindoraTools, [
  "health_check",
  "search_funders",
  "search_open_grants",
  "search_funder_jobs",
  "get_funder_profile",
  "get_990_summary",
  "get_foundation_grants",
  "get_funder_stats",
  "get_ntee_codes",
]);
