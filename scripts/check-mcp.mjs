import { spawn } from "node:child_process";

const child = spawn(process.execPath, ["mcp/server.mjs"], {
  cwd: new URL("..", import.meta.url),
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

setTimeout(() => {
  child.kill();
  const lines = output.trim().split("\n").filter(Boolean).map((line) => JSON.parse(line));
  const toolList = lines.find((line) => line.id === 2)?.result?.tools ?? [];
  const toolNames = toolList.map((tool) => tool.name);
  const required = [
    "search_nonprofits",
    "get_organization",
    "get_foundation_filings",
    "get_filing_xml",
  ];
  const missing = required.filter((name) => !toolNames.includes(name));
  if (missing.length > 0) {
    console.error(`Missing tools: ${missing.join(", ")}`);
    process.exit(1);
  }
  console.log(`MCP check passed: ${toolNames.join(", ")}`);
}, 250);
