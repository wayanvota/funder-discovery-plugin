import readline from "node:readline";

const SERVER_NAME = "ProPublica 990 Lookup";
const SERVER_VERSION = "0.1.0";
const BASE_URL = "https://projects.propublica.org/nonprofits/api/v2";
const JsonRpcError = {
  METHOD_NOT_FOUND: -32601,
  INVALID_PARAMS: -32602,
  INTERNAL_ERROR: -32603,
};

function send(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

function sendResult(id, result) {
  send({ jsonrpc: "2.0", id, result });
}

function sendError(id, code, message) {
  send({ jsonrpc: "2.0", id, error: { code, message } });
}

function requireString(value, name) {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`${name} must be a non-empty string.`);
  }
  return value.trim();
}

function normalizeEin(value) {
  const ein = requireString(value, "ein").replace(/[^0-9]/g, "");
  if (!/^[0-9]{9}$/.test(ein)) {
    throw new Error("ein must contain 9 digits.");
  }
  return ein;
}

function boundedInteger(value, name, min, max, fallback) {
  if (value === undefined || value === null) {
    return fallback;
  }
  const number = Number(value);
  if (!Number.isInteger(number) || number < min || number > max) {
    throw new Error(`${name} must be an integer from ${min} to ${max}.`);
  }
  return number;
}

async function fetchJson(url) {
  const response = await fetch(url, {
    headers: {
      "accept": "application/json",
      "user-agent": "funder-discovery-plugin/0.1.0",
    },
  });
  if (!response.ok) {
    throw new Error(`ProPublica request failed with HTTP ${response.status}.`);
  }
  return response.json();
}

async function fetchText(url) {
  const response = await fetch(url, {
    headers: {
      "accept": "application/xml,text/xml,text/plain,*/*",
      "user-agent": "funder-discovery-plugin/0.1.0",
    },
  });
  if (!response.ok) {
    throw new Error(`Filing XML request failed with HTTP ${response.status}.`);
  }
  return response.text();
}

function compactOrganization(org) {
  if (!org || typeof org !== "object") {
    return org;
  }
  return {
    ein: org.ein,
    name: org.name,
    careofname: org.careofname,
    address: org.address,
    city: org.city,
    state: org.state,
    zipcode: org.zipcode,
    ntee_code: org.ntee_code,
    subseccd: org.subseccd,
    classification: org.classification,
    ruling_date: org.ruling_date,
    deductibility: org.deductibility,
    foundation: org.foundation,
    organization: org.organization,
    exempt_organization_status: org.exempt_organization_status,
    total_revenue: org.total_revenue,
    total_assets: org.total_assets,
    mission: org.mission,
  };
}

function compactFiling(filing) {
  if (!filing || typeof filing !== "object") {
    return filing;
  }
  return {
    tax_prd: filing.tax_prd,
    tax_prd_yr: filing.tax_prd_yr,
    formtype: filing.formtype,
    updated: filing.updated,
    pdf_url: filing.pdf_url,
    xml_url: filing.xml_url,
    totrevenue: filing.totrevenue,
    total_assets: filing.total_assets,
    totassetsend: filing.totassetsend,
    totfuncexpns: filing.totfuncexpns,
    contrpdpbks: filing.contrpdpbks,
    totcntrbgfts: filing.totcntrbgfts,
    totprgmrevnue: filing.totprgmrevnue,
    grsincfndrsng: filing.grsincfndrsng,
    lessdirfndrsng: filing.lessdirfndrsng,
    netincfndrsng: filing.netincfndrsng,
    totgivinggrnts: filing.totgivinggrnts,
    qlfydistribtot: filing.qlfydistribtot,
    totexpnspbks: filing.totexpnspbks,
    fairmrktvalamt: filing.fairmrktvalamt,
  };
}

async function searchNonprofits(args) {
  const query = requireString(args.q ?? args.query, "q");
  const limit = boundedInteger(args.limit, "limit", 1, 50, 20);
  const state = typeof args.state === "string" ? args.state.trim().toUpperCase() : null;
  const nteeCode = typeof args.ntee_code === "string" ? args.ntee_code.trim().toUpperCase() : null;
  const url = new URL(`${BASE_URL}/search.json`);
  url.searchParams.set("q", query);
  const data = await fetchJson(url);
  let results = Array.isArray(data.organizations) ? data.organizations : [];
  if (state) {
    results = results.filter((org) => String(org.state ?? "").toUpperCase() === state);
  }
  if (nteeCode) {
    results = results.filter((org) => String(org.ntee_code ?? "").toUpperCase().startsWith(nteeCode));
  }
  return {
    query,
    count: results.length,
    results: results.slice(0, limit).map(compactOrganization),
  };
}

async function getOrganization(args) {
  const ein = normalizeEin(args.ein);
  const data = await fetchJson(`${BASE_URL}/organizations/${ein}.json`);
  return {
    organization: compactOrganization(data.organization),
    filings_with_data: (data.filings_with_data ?? []).map(compactFiling),
    filings_without_data: data.filings_without_data ?? [],
  };
}

async function getFoundationFilings(args) {
  const ein = normalizeEin(args.ein);
  const limit = boundedInteger(args.limit, "limit", 1, 20, 10);
  const data = await fetchJson(`${BASE_URL}/organizations/${ein}.json`);
  const filings = (data.filings_with_data ?? []).slice(0, limit).map(compactFiling);
  return {
    organization: compactOrganization(data.organization),
    filing_count: filings.length,
    filings,
  };
}

async function getFilingXml(args) {
  const url = requireString(args.xml_url, "xml_url");
  const maxChars = boundedInteger(args.max_chars, "max_chars", 1000, 200000, 50000);
  const parsed = new URL(url);
  if (!["https:", "http:"].includes(parsed.protocol)) {
    throw new Error("xml_url must be an http or https URL.");
  }
  const text = await fetchText(parsed.toString());
  return {
    xml_url: parsed.toString(),
    returned_chars: Math.min(text.length, maxChars),
    total_chars: text.length,
    truncated: text.length > maxChars,
    xml: text.slice(0, maxChars),
  };
}

const tools = [
  {
    name: "search_nonprofits",
    title: "Search Nonprofits",
    description: "Search ProPublica Nonprofit Explorer by organization name or keyword. Optional filters are applied locally.",
    inputSchema: {
      type: "object",
      properties: {
        q: { type: "string", description: "Organization name or keyword." },
        state: { type: "string", description: "Optional two-letter state filter." },
        ntee_code: { type: "string", description: "Optional NTEE prefix filter, such as B or B20." },
        limit: { type: "integer", minimum: 1, maximum: 50, default: 20 },
      },
      required: ["q"],
    },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  },
  {
    name: "get_organization",
    title: "Get Organization",
    description: "Fetch ProPublica organization details and available filing summaries by EIN.",
    inputSchema: {
      type: "object",
      properties: {
        ein: { type: "string", description: "Nine-digit EIN, with or without hyphen." },
      },
      required: ["ein"],
    },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  },
  {
    name: "get_foundation_filings",
    title: "Get Foundation Filings",
    description: "Fetch recent ProPublica filing summaries and PDF filing URLs for a foundation by EIN.",
    inputSchema: {
      type: "object",
      properties: {
        ein: { type: "string", description: "Nine-digit EIN, with or without hyphen." },
        limit: { type: "integer", minimum: 1, maximum: 20, default: 10 },
      },
      required: ["ein"],
    },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  },
  {
    name: "get_filing_xml",
    title: "Get Filing XML",
    description: "Fetch an IRS filing XML document by caller-supplied URL, capped to a caller-specified character limit.",
    inputSchema: {
      type: "object",
      properties: {
        xml_url: { type: "string", description: "An IRS filing XML URL supplied by the caller or another filing source." },
        max_chars: { type: "integer", minimum: 1000, maximum: 200000, default: 50000 },
      },
      required: ["xml_url"],
    },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  },
];

async function handleToolCall(id, params) {
  const args = params?.arguments ?? {};
  let structuredContent;
  if (params?.name === "search_nonprofits") {
    structuredContent = await searchNonprofits(args);
  } else if (params?.name === "get_organization") {
    structuredContent = await getOrganization(args);
  } else if (params?.name === "get_foundation_filings") {
    structuredContent = await getFoundationFilings(args);
  } else if (params?.name === "get_filing_xml") {
    structuredContent = await getFilingXml(args);
  } else {
    sendError(id, JsonRpcError.INVALID_PARAMS, `Unknown tool: ${params?.name ?? ""}`);
    return;
  }

  sendResult(id, {
    content: [
      {
        type: "text",
        text: JSON.stringify(structuredContent, null, 2),
      },
    ],
    structuredContent,
  });
}

async function handleRequest(message) {
  const { id, method, params } = message;
  if (method === "initialize") {
    sendResult(id, {
      protocolVersion: params?.protocolVersion ?? "2025-11-25",
      capabilities: { tools: {} },
      serverInfo: { name: SERVER_NAME, version: SERVER_VERSION },
      instructions:
        "Use these read-only ProPublica tools to verify nonprofit EINs, organization records, filing years, PDF filing URLs, and 990 summary fields. Prefer Kindora for grant-level foundation search and giving statistics when available.",
    });
    return;
  }
  if (method === "ping") {
    sendResult(id, {});
    return;
  }
  if (method === "tools/list") {
    sendResult(id, { tools });
    return;
  }
  if (method === "tools/call") {
    try {
      await handleToolCall(id, params);
    } catch (error) {
      sendError(
        id,
        JsonRpcError.INVALID_PARAMS,
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
