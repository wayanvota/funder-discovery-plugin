import http from "node:http";
import path from "node:path";
import { pathToFileURL } from "node:url";

const PORT = Number.parseInt(process.env.PORT ?? "8080", 10);
const KINDORA_MCP_URL = process.env.KINDORA_MCP_URL ?? "https://kindora-mcp.azurewebsites.net/mcp/";
const KINDORA_API_KEY = process.env.KINDORA_API_KEY;
const KINDORA_TIMEOUT_MS = Number.parseInt(process.env.KINDORA_TIMEOUT ?? "60000", 10);
const USE_MOCK_DATA = process.env.FUNDER_DISCOVERY_MOCK === "1";
const DEFAULT_BASE_URL = process.env.PUBLIC_BASE_URL ?? `http://localhost:${PORT}`;

const requiredProfileFields = [
  ["mission", "What is your organization's mission in one sentence?"],
  ["programsOrFundingNeeds", "What program, project, or funding need should we find foundation support for?"],
  ["geographyServed", "Where does your work happen: city, state, region, country, or national?"],
  ["beneficiaries", "Who directly benefits from the work?"],
  ["desiredGrantSize", "What grant size range would be useful, even if approximate?"],
  ["fundingType", "What kind of funding do you need: general operating, program, capital, research, advocacy, or something else?"],
];

const openApi = {
  openapi: "3.1.0",
  info: {
    title: "Funder Discovery Pilot Actions",
    version: "0.1.0",
    description:
      "Actions API for a Custom GPT that collects nonprofit details, discovers aligned foundations, scores fit, and returns a shortlisted donor pipeline.",
  },
  servers: [{ url: DEFAULT_BASE_URL }],
  paths: {
    "/health": {
      get: {
        operationId: "healthCheck",
        summary: "Check API health",
        responses: {
          "200": {
            description: "API health status",
            content: { "application/json": { schema: { type: "object" } } },
          },
        },
      },
    },
    "/api/intake/check": {
      post: {
        operationId: "checkOrganizationProfile",
        summary: "Check whether the nonprofit profile has enough detail for discovery",
        requestBody: {
          required: true,
          content: { "application/json": { schema: { $ref: "#/components/schemas/ProfileCheckRequest" } } },
        },
        responses: {
          "200": {
            description: "Profile readiness and missing questions",
            content: { "application/json": { schema: { $ref: "#/components/schemas/ProfileCheckResponse" } } },
          },
        },
      },
    },
    "/api/funder-discovery/run": {
      post: {
        operationId: "runFunderDiscoveryPilot",
        summary: "Run discovery, scoring, briefs, and CSV pipeline generation",
        description:
          "Use this after the GPT has collected the user's organization profile. Returns questions if the profile is incomplete.",
        requestBody: {
          required: true,
          content: { "application/json": { schema: { $ref: "#/components/schemas/DiscoveryRunRequest" } } },
        },
        responses: {
          "200": {
            description: "Discovery result or intake questions",
            content: { "application/json": { schema: { $ref: "#/components/schemas/DiscoveryRunResponse" } } },
          },
        },
      },
    },
    "/api/score": {
      post: {
        operationId: "scoreFoundationProspects",
        summary: "Score candidate foundations using the transparent fit rubric",
        requestBody: {
          required: true,
          content: { "application/json": { schema: { $ref: "#/components/schemas/ScoreRequest" } } },
        },
        responses: {
          "200": {
            description: "Scored candidate foundations",
            content: { "application/json": { schema: { type: "object" } } },
          },
        },
      },
    },
    "/api/pipeline/csv": {
      post: {
        operationId: "buildPipelineCsv",
        summary: "Build a CRM-ready CSV from scored foundation prospects",
        requestBody: {
          required: true,
          content: { "application/json": { schema: { $ref: "#/components/schemas/PipelineCsvRequest" } } },
        },
        responses: {
          "200": {
            description: "CSV pipeline",
            content: { "application/json": { schema: { type: "object" } } },
          },
        },
      },
    },
  },
  components: {
    schemas: {
      OrganizationProfile: {
        type: "object",
        additionalProperties: true,
        properties: {
          organizationName: { type: "string" },
          ein: { type: "string" },
          website: { type: "string" },
          mission: { type: "string" },
          programsOrFundingNeeds: { type: "string" },
          geographyServed: { type: "string" },
          beneficiaries: { type: "string" },
          annualBudget: { type: "string" },
          budgetBand: { type: "string" },
          desiredGrantSize: {
            oneOf: [
              { type: "string" },
              {
                type: "object",
                properties: {
                  min: { type: "number" },
                  max: { type: "number" },
                  target: { type: "number" },
                },
                additionalProperties: true,
              },
            ],
          },
          fundingType: { type: "string" },
          evidenceOfResults: { type: "string" },
          currentFunders: { type: "array", items: { type: "string" } },
          relationshipAssets: { type: "array", items: { type: "string" } },
          exclusions: { type: "array", items: { type: "string" } },
          deadlineContext: { type: "string" },
          ownerNames: { type: "array", items: { type: "string" } },
        },
      },
      ProfileCheckRequest: {
        type: "object",
        properties: {
          organizationProfile: { $ref: "#/components/schemas/OrganizationProfile" },
        },
        required: ["organizationProfile"],
      },
      ProfileCheckResponse: {
        type: "object",
        properties: {
          ready: { type: "boolean" },
          completenessScore: { type: "number" },
          missingFields: { type: "array", items: { type: "string" } },
          questions: { type: "array", items: { type: "string" } },
          assumptions: { type: "array", items: { type: "string" } },
        },
      },
      DiscoveryRunRequest: {
        type: "object",
        properties: {
          organizationProfile: { $ref: "#/components/schemas/OrganizationProfile" },
          options: {
            type: "object",
            additionalProperties: true,
            properties: {
              maxProspects: { type: "integer", minimum: 3, maximum: 12, default: 6 },
              shortlistSize: { type: "integer", minimum: 3, maximum: 8, default: 5 },
              includeOpenGrants: { type: "boolean", default: true },
              ownerDefault: { type: "string", default: "Unassigned" },
              mockMode: { type: "boolean", default: false },
            },
          },
        },
        required: ["organizationProfile"],
      },
      DiscoveryRunResponse: {
        type: "object",
        additionalProperties: true,
        properties: {
          status: { type: "string", enum: ["needs_more_info", "complete", "partial"] },
          questions: { type: "array", items: { type: "string" } },
          summary: { type: "string" },
          prospects: { type: "array", items: { type: "object", additionalProperties: true } },
          briefs: { type: "array", items: { type: "object", additionalProperties: true } },
          pipelineRows: { type: "array", items: { type: "object", additionalProperties: true } },
          csv: { type: "string" },
          testObservations: { type: "array", items: { type: "string" } },
          sourceNotes: { type: "array", items: { type: "string" } },
        },
      },
      ScoreRequest: {
        type: "object",
        properties: {
          organizationProfile: { $ref: "#/components/schemas/OrganizationProfile" },
          prospects: { type: "array", items: { type: "object", additionalProperties: true } },
        },
        required: ["organizationProfile", "prospects"],
      },
      PipelineCsvRequest: {
        type: "object",
        properties: {
          organizationProfile: { $ref: "#/components/schemas/OrganizationProfile" },
          prospects: { type: "array", items: { type: "object", additionalProperties: true } },
          ownerDefault: { type: "string", default: "Unassigned" },
        },
        required: ["organizationProfile", "prospects"],
      },
    },
  },
};

const mockCandidates = [
  {
    name: "Sample Community Opportunity Fund",
    ein: "123456789",
    location: "New York, NY",
    website: "https://example.org/community-opportunity",
    total_assets: 85000000,
    annual_grants: 5200000,
    foundation_type: "independent_foundation",
    latest_filing_year: 2024,
    typical_grant_size: 75000,
    focus_areas: ["youth development", "workforce readiness", "community opportunity"],
    geography: "New York and national demonstration projects",
    recent_grants: [
      { recipient: "Youth Futures Network", amount: 85000, year: 2024, purpose: "Youth workforce training" },
      { recipient: "Community Pathways", amount: 65000, year: 2023, purpose: "Career readiness" },
    ],
    openness: "Public LOI accepted twice per year",
  },
  {
    name: "North Star Family Foundation",
    ein: "987654321",
    location: "Minneapolis, MN",
    website: "https://example.org/north-star-family",
    total_assets: 42000000,
    annual_grants: 2100000,
    foundation_type: "family_foundation",
    latest_filing_year: 2023,
    typical_grant_size: 35000,
    focus_areas: ["education", "basic needs", "youth mentoring"],
    geography: "Upper Midwest",
    recent_grants: [
      { recipient: "MentorWorks", amount: 40000, year: 2023, purpose: "Youth mentoring and case management" },
    ],
    openness: "No public application found, but repeat grants to new nonprofits appear in filings",
  },
  {
    name: "Bridge Builders Foundation",
    ein: "112233445",
    location: "San Francisco, CA",
    website: "https://example.org/bridge-builders",
    total_assets: 130000000,
    annual_grants: 9800000,
    foundation_type: "independent_foundation",
    latest_filing_year: 2024,
    typical_grant_size: 125000,
    focus_areas: ["economic mobility", "digital inclusion", "youth employment"],
    geography: "California and scalable national models",
    recent_grants: [
      { recipient: "Digital Futures", amount: 150000, year: 2024, purpose: "Digital skills for low-income youth" },
    ],
    openness: "Staff contact and inquiry form listed",
  },
  {
    name: "Legacy Arts Trust",
    ein: "556677889",
    location: "Boston, MA",
    website: "https://example.org/legacy-arts",
    total_assets: 22000000,
    annual_grants: 900000,
    foundation_type: "family_foundation",
    latest_filing_year: 2022,
    typical_grant_size: 20000,
    focus_areas: ["arts preservation", "historic buildings"],
    geography: "Massachusetts",
    recent_grants: [
      { recipient: "Historic Stage Society", amount: 25000, year: 2022, purpose: "Theater restoration" },
    ],
    openness: "Invitation-only language on website",
  },
  {
    name: "Civic Futures Fund",
    ein: "667788990",
    location: "Washington, DC",
    website: "https://example.org/civic-futures",
    total_assets: 61000000,
    annual_grants: 4500000,
    foundation_type: "independent_foundation",
    latest_filing_year: 2024,
    typical_grant_size: 90000,
    focus_areas: ["civic participation", "youth leadership", "community organizing"],
    geography: "National",
    recent_grants: [
      { recipient: "Young Leaders Table", amount: 100000, year: 2024, purpose: "Youth civic leadership" },
    ],
    openness: "Concept notes accepted through intermediary referrals",
  },
];

function sendJson(res, statusCode, payload) {
  const body = JSON.stringify(payload, null, 2);
  res.writeHead(statusCode, {
    "content-type": "application/json; charset=utf-8",
    "access-control-allow-origin": "*",
    "access-control-allow-methods": "GET,POST,OPTIONS",
    "access-control-allow-headers": "content-type,authorization",
  });
  res.end(body);
}

function openApiForRequest(req) {
  const forwardedProto = req.headers["x-forwarded-proto"];
  const proto = Array.isArray(forwardedProto) ? forwardedProto[0] : forwardedProto;
  const publicUrl = process.env.PUBLIC_BASE_URL ?? `${proto || "https"}://${req.headers.host}`;
  return {
    ...openApi,
    servers: [{ url: publicUrl }],
  };
}

async function readJson(req) {
  const chunks = [];
  for await (const chunk of req) {
    chunks.push(chunk);
  }
  const body = Buffer.concat(chunks).toString("utf8");
  if (!body.trim()) {
    return {};
  }
  return JSON.parse(body);
}

function text(value) {
  if (Array.isArray(value)) {
    return value.filter(Boolean).join("; ");
  }
  if (value && typeof value === "object") {
    return Object.values(value).filter(Boolean).join("; ");
  }
  return value === undefined || value === null ? "" : String(value);
}

function isBlank(value) {
  return text(value).trim().length === 0;
}

function checkProfile(organizationProfile = {}) {
  const missing = requiredProfileFields
    .filter(([field]) => isBlank(organizationProfile[field]))
    .map(([field]) => field);
  const questions = requiredProfileFields
    .filter(([field]) => missing.includes(field))
    .map(([, question]) => question);
  const optionalSignals = [
    "evidenceOfResults",
    "currentFunders",
    "relationshipAssets",
    "budgetBand",
    "deadlineContext",
  ];
  const presentRequired = requiredProfileFields.length - missing.length;
  const presentOptional = optionalSignals.filter((field) => !isBlank(organizationProfile[field])).length;
  const completenessScore = Math.round(
    ((presentRequired / requiredProfileFields.length) * 75 + (presentOptional / optionalSignals.length) * 25) * 10,
  ) / 10;

  const assumptions = [];
  if (isBlank(organizationProfile.relationshipAssets)) {
    assumptions.push("Relationship path will be scored conservatively until board, staff, partner, or peer-grantee connections are supplied.");
  }
  if (isBlank(organizationProfile.evidenceOfResults)) {
    assumptions.push("Program fit will rely on mission and grant pattern, not independently verified outcomes.");
  }
  return {
    ready: missing.length === 0,
    completenessScore,
    missingFields: missing,
    questions: questions.slice(0, 4),
    assumptions,
  };
}

function parseGrantRange(value) {
  if (value && typeof value === "object") {
    const min = Number(value.min ?? value.target ?? value.max);
    const max = Number(value.max ?? value.target ?? value.min);
    return {
      min: Number.isFinite(min) ? min : 0,
      max: Number.isFinite(max) ? max : Number.POSITIVE_INFINITY,
    };
  }
  const source = text(value).replace(/,/g, "");
  const numbers = [...source.matchAll(/\$?\s*(\d+(?:\.\d+)?)\s*(k|m|million|thousand)?/gi)].map((match) => {
    const raw = Number(match[1]);
    const suffix = String(match[2] ?? "").toLowerCase();
    if (suffix === "m" || suffix === "million") {
      return raw * 1000000;
    }
    if (suffix === "k" || suffix === "thousand") {
      return raw * 1000;
    }
    return raw;
  });
  if (numbers.length === 0) {
    return { min: 0, max: Number.POSITIVE_INFINITY };
  }
  if (numbers.length === 1) {
    return { min: numbers[0] * 0.6, max: numbers[0] * 1.6 };
  }
  return { min: Math.min(...numbers), max: Math.max(...numbers) };
}

function keywordSet(profile) {
  const source = [
    profile.mission,
    profile.programsOrFundingNeeds,
    profile.beneficiaries,
    profile.fundingType,
  ].map(text).join(" ").toLowerCase();
  const stop = new Set([
    "and", "the", "for", "with", "from", "that", "this", "our", "their", "into", "about",
    "program", "programs", "services", "support", "funding", "nonprofit", "organization",
  ]);
  return new Set(
    source
      .replace(/[^a-z0-9 ]/g, " ")
      .split(/\s+/)
      .filter((word) => word.length > 3 && !stop.has(word))
      .slice(0, 25),
  );
}

function haystack(candidate) {
  return JSON.stringify(candidate ?? {}).toLowerCase();
}

function scoreProspect(profile, candidate) {
  const grantRange = parseGrantRange(profile.desiredGrantSize);
  const words = keywordSet(profile);
  const candidateText = haystack(candidate);
  const matchingKeywords = [...words].filter((word) => candidateText.includes(word));
  const programFit = clamp(Math.round((matchingKeywords.length / Math.max(words.size, 1)) * 25) + (matchingKeywords.length >= 2 ? 6 : 0), 0, 25);

  const geographyTerms = text(profile.geographyServed).toLowerCase().split(/[,;/]|\band\b/).map((term) => term.trim()).filter(Boolean);
  const geographyHits = geographyTerms.filter((term) => term.length > 1 && candidateText.includes(term));
  const geographyFit = geographyHits.length > 0 || candidateText.includes("national") ? 17 : 8;

  const typicalGrant = Number(candidate.typical_grant_size ?? candidate.avg_grant_size ?? candidate.average_grant_size ?? candidate.median_grant_size ?? 0);
  let grantSizeFit = 7;
  if (Number.isFinite(typicalGrant) && typicalGrant > 0) {
    if (typicalGrant >= grantRange.min && typicalGrant <= grantRange.max) {
      grantSizeFit = 15;
    } else if (typicalGrant >= grantRange.min * 0.5 && typicalGrant <= grantRange.max * 2) {
      grantSizeFit = 11;
    } else {
      grantSizeFit = 5;
    }
  }

  const currentYear = new Date().getFullYear();
  const latestYear = Number(candidate.latest_filing_year ?? candidate.tax_prd_yr ?? candidate.tax_year ?? 0);
  const recency = latestYear >= currentYear - 2 ? 15 : latestYear >= currentYear - 4 ? 10 : latestYear > 0 ? 5 : 4;

  const opennessText = text(candidate.openness ?? candidate.application_process ?? candidate.website ?? "").toLowerCase();
  let openness = 6;
  if (/(public|open|loi|inquiry|application|rfp|contact|form)/.test(opennessText)) {
    openness = 13;
  } else if (/(invitation|invite|family|closed)/.test(opennessText)) {
    openness = 3;
  }

  const relationshipAssets = text(profile.relationshipAssets).toLowerCase();
  let relationshipPath = relationshipAssets.length > 0 ? 6 : 2;
  if (relationshipAssets && candidateText.split(/\W+/).some((token) => token.length > 4 && relationshipAssets.includes(token))) {
    relationshipPath = 9;
  }

  const totalFitScore = programFit + geographyFit + grantSizeFit + recency + openness + relationshipPath;
  const evidenceCount = [
    matchingKeywords.length > 0,
    geographyHits.length > 0,
    typicalGrant > 0,
    latestYear > 0,
    candidate.recent_grants || candidate.grants,
  ].filter(Boolean).length;

  return {
    programFitScore: programFit,
    geographyFitScore: geographyFit,
    grantSizeFitScore: grantSizeFit,
    recencyScore: recency,
    opennessScore: openness,
    relationshipPathScore: relationshipPath,
    totalFitScore,
    confidence: evidenceCount >= 4 ? "High" : evidenceCount >= 2 ? "Medium" : "Low",
    rationale: buildRationale(candidate, matchingKeywords, geographyHits, typicalGrant, latestYear),
    mainRisk: buildRisk(candidate, matchingKeywords, geographyHits),
  };
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function buildRationale(candidate, matchingKeywords, geographyHits, typicalGrant, latestYear) {
  const parts = [];
  if (matchingKeywords.length > 0) {
    parts.push(`Program language overlaps on ${matchingKeywords.slice(0, 5).join(", ")}.`);
  }
  if (geographyHits.length > 0) {
    parts.push(`Geography evidence mentions ${geographyHits.slice(0, 3).join(", ")}.`);
  }
  if (typicalGrant > 0) {
    parts.push(`Typical grant size appears near ${formatMoney(typicalGrant)}.`);
  }
  if (latestYear > 0) {
    parts.push(`Latest filing or grant evidence reviewed: ${latestYear}.`);
  }
  return parts.join(" ") || `Candidate has limited structured evidence and needs manual review.`;
}

function buildRisk(candidate, matchingKeywords, geographyHits) {
  if (matchingKeywords.length === 0) {
    return "Program fit is weak or not visible in available data.";
  }
  if (geographyHits.length === 0 && !haystack(candidate).includes("national")) {
    return "Geography fit is plausible but not confirmed.";
  }
  if (/(invitation|invite|closed)/i.test(text(candidate.openness))) {
    return "Access may be relationship-driven or invitation-only.";
  }
  return "Confirm current guidelines before outreach because public filings can lag.";
}

function formatMoney(value) {
  const number = Number(value);
  if (!Number.isFinite(number)) {
    return "";
  }
  return new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 }).format(number);
}

function parseSseOrJson(textBody) {
  const trimmed = textBody.trim();
  if (trimmed.startsWith("{")) {
    return JSON.parse(trimmed);
  }
  const dataLines = trimmed
    .split(/\r?\n/)
    .filter((line) => line.startsWith("data:"))
    .map((line) => line.slice(5).trim())
    .filter(Boolean);
  if (dataLines.length === 0) {
    throw new Error("Kindora response did not contain JSON or SSE data.");
  }
  return JSON.parse(dataLines.join("\n"));
}

async function callKindoraTool(name, args) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), KINDORA_TIMEOUT_MS);
  try {
    const headers = {
      "accept": "application/json, text/event-stream",
      "content-type": "application/json",
      "user-agent": "funder-discovery-pilot-actions/0.1.0",
    };
    if (KINDORA_API_KEY) {
      headers.authorization = `Bearer ${KINDORA_API_KEY}`;
    }
    const response = await fetch(KINDORA_MCP_URL, {
      method: "POST",
      headers,
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: `actions-${name}-${Date.now()}`,
        method: "tools/call",
        params: { name, arguments: args },
      }),
      signal: controller.signal,
    });
    const body = await response.text();
    if (!response.ok) {
      throw new Error(`Kindora returned HTTP ${response.status}: ${body.slice(0, 300)}`);
    }
    const message = parseSseOrJson(body);
    if (message.error) {
      throw new Error(message.error.message ?? JSON.stringify(message.error));
    }
    return message.result?.structuredContent ?? tryParseTextContent(message.result) ?? message.result;
  } finally {
    clearTimeout(timeout);
  }
}

function tryParseTextContent(result) {
  const textContent = result?.content?.find?.((item) => item.type === "text")?.text;
  if (!textContent) {
    return null;
  }
  try {
    return JSON.parse(textContent);
  } catch {
    return { text: textContent };
  }
}

async function discoverCandidates(profile, options) {
  if (USE_MOCK_DATA || options?.mockMode) {
    return { candidates: mockCandidates, sourceNotes: ["Using mock data for deterministic pilot testing."] };
  }

  const queries = buildSearchQueries(profile);
  const candidates = new Map();
  const sourceNotes = [];
  for (const query of queries) {
    try {
      const result = await callKindoraTool("search_funders", {
        query,
        limit: Math.min(Number(options?.maxProspects ?? 8), 20),
        exclude_funder_types: ["operating_nonprofit"],
      });
      sourceNotes.push(`Kindora search_funders query: ${query}`);
      for (const candidate of extractCandidates(result)) {
        const key = text(candidate.ein ?? candidate.EIN ?? candidate.name ?? candidate.legal_name);
        if (key && !candidates.has(key)) {
          candidates.set(key, normalizeCandidate(candidate));
        }
      }
    } catch (error) {
      sourceNotes.push(`Kindora search failed for "${query}": ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  const initial = [...candidates.values()].slice(0, clamp(Number(options?.maxProspects ?? 6), 3, 8));
  const detailed = [];
  for (const candidate of initial) {
    detailed.push(await enrichCandidate(candidate, profile, sourceNotes));
  }
  return { candidates: detailed, sourceNotes };
}

function buildSearchQueries(profile) {
  const base = [
    text(profile.programsOrFundingNeeds),
    text(profile.mission),
    text(profile.beneficiaries),
  ].filter(Boolean);
  const compact = [...new Set(base.map((item) => item.split(/[.;]/)[0].trim()).filter(Boolean))];
  const primary = compact[0] ?? "nonprofit community programs";
  const secondary = compact[1] ?? compact[0] ?? "nonprofit grants";
  return [
    primary,
    `${primary} ${text(profile.geographyServed)}`.trim(),
    secondary,
  ].slice(0, 3);
}

function extractCandidates(result) {
  const candidates = [];
  function visit(value) {
    if (!value) {
      return;
    }
    if (Array.isArray(value)) {
      value.forEach(visit);
      return;
    }
    if (typeof value === "object") {
      const maybeName = value.name ?? value.legal_name ?? value.foundation_name ?? value.organization_name;
      const maybeEin = value.ein ?? value.EIN;
      if (maybeName || maybeEin) {
        candidates.push(value);
        return;
      }
      Object.values(value).forEach(visit);
    }
  }
  visit(result);
  return candidates;
}

function normalizeCandidate(candidate) {
  return {
    ...candidate,
    name: candidate.name ?? candidate.legal_name ?? candidate.foundation_name ?? candidate.organization_name,
    ein: candidate.ein ?? candidate.EIN,
    location: candidate.location ?? [candidate.city, candidate.state, candidate.country].filter(Boolean).join(", "),
    total_assets: candidate.total_assets ?? candidate.assets ?? candidate.totalAssets,
    annual_grants: candidate.annual_grants ?? candidate.grants_paid ?? candidate.total_grants,
    typical_grant_size: candidate.typical_grant_size ?? candidate.avg_grant_size ?? candidate.average_grant_size,
    latest_filing_year: candidate.latest_filing_year ?? candidate.tax_prd_yr ?? candidate.tax_year,
  };
}

async function enrichCandidate(candidate, profile, sourceNotes) {
  if (!candidate.ein || USE_MOCK_DATA) {
    return candidate;
  }
  const enriched = { ...candidate };
  const detailCalls = [
    ["get_funder_profile", { ein: candidate.ein }],
    ["get_990_summary", { ein: candidate.ein, years: 5 }],
    ["get_funder_stats", { ein: candidate.ein }],
    ["get_foundation_grants", { ein: candidate.ein, limit: 12 }],
  ];
  const detailResults = await Promise.allSettled(
    detailCalls.map(async ([toolName, args]) => ({
      toolName,
      result: await callKindoraTool(toolName, args),
    })),
  );
  for (const detail of detailResults) {
    if (detail.status === "fulfilled") {
      Object.assign(enriched, flattenUsefulFields(detail.value.toolName, detail.value.result));
      sourceNotes.push(`Kindora ${detail.value.toolName}: ${candidate.name ?? candidate.ein}`);
    } else {
      sourceNotes.push(`Kindora detail lookup failed for ${candidate.name ?? candidate.ein}: ${detail.reason instanceof Error ? detail.reason.message : String(detail.reason)}`);
    }
  }
  if (!enriched.latest_filing_year && candidate.ein) {
    try {
      const propublica = await getPropublicaFilings(candidate.ein);
      Object.assign(enriched, propublica);
      sourceNotes.push(`ProPublica filing lookup: ${candidate.name ?? candidate.ein}`);
    } catch (error) {
      sourceNotes.push(`ProPublica lookup failed for ${candidate.name ?? candidate.ein}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  enriched._profileContext = {
    desiredGrantSize: profile.desiredGrantSize,
    geographyServed: profile.geographyServed,
  };
  return normalizeCandidate(enriched);
}

function flattenUsefulFields(toolName, result) {
  const output = {};
  const body = result && typeof result === "object" ? result : {};
  const textBody = JSON.stringify(body);
  if (toolName === "get_funder_profile") {
    const profile = body.profile ?? body.funder ?? body.organization ?? body;
    output.name = output.name ?? profile.name ?? profile.legal_name;
    output.location = profile.location ?? [profile.city, profile.state, profile.country].filter(Boolean).join(", ");
    output.website = profile.website ?? profile.url;
    output.total_assets = profile.total_assets ?? profile.assets;
    output.annual_grants = profile.annual_grants ?? profile.grants_paid;
    output.foundation_type = profile.foundation_type ?? profile.funder_type;
    output.leadership = profile.leadership ?? profile.board ?? profile.officers;
  }
  if (toolName === "get_990_summary") {
    const years = body.years ?? body.filings ?? body.summaries ?? [];
    const latest = Array.isArray(years) ? years[0] : body.latest ?? body;
    output.latest_filing_year = latest?.year ?? latest?.tax_year ?? latest?.tax_prd_yr;
    output.annual_grants = output.annual_grants ?? latest?.grants_paid ?? latest?.total_grants;
    output.total_assets = output.total_assets ?? latest?.assets ?? latest?.end_of_year_assets;
    output.revenue = latest?.revenue;
    output.financial_summary = body;
  }
  if (toolName === "get_funder_stats") {
    output.typical_grant_size = body.average_grant_size ?? body.avg_grant_size ?? body.median_grant_size;
    output.focus_areas = body.top_ntee_focus_areas ?? body.focus_areas ?? body.top_focus_areas;
    output.geography = body.recipient_state_distribution ?? body.recipient_country_distribution ?? body.geography;
    output.giving_stats = body;
  }
  if (toolName === "get_foundation_grants") {
    output.recent_grants = body.grants ?? body.results ?? body.foundation_grants ?? [];
    if (!output.typical_grant_size && Array.isArray(output.recent_grants) && output.recent_grants.length > 0) {
      const amounts = output.recent_grants.map((grant) => Number(grant.amount ?? grant.grant_amount)).filter(Number.isFinite);
      if (amounts.length > 0) {
        output.typical_grant_size = Math.round(amounts.reduce((sum, amount) => sum + amount, 0) / amounts.length);
      }
    }
  }
  output.raw_excerpt = textBody.slice(0, 2500);
  return output;
}

async function getPropublicaFilings(ein) {
  const normalizedEin = text(ein).replace(/[^0-9]/g, "");
  if (!/^[0-9]{9}$/.test(normalizedEin)) {
    return {};
  }
  const response = await fetch(`https://projects.propublica.org/nonprofits/api/v2/organizations/${normalizedEin}.json`, {
    headers: { "accept": "application/json", "user-agent": "funder-discovery-pilot-actions/0.1.0" },
  });
  if (!response.ok) {
    throw new Error(`ProPublica returned HTTP ${response.status}`);
  }
  const body = await response.json();
  const latest = body.filings_with_data?.[0] ?? {};
  return {
    latest_filing_year: latest.tax_prd_yr,
    total_assets: latest.totassetsend,
    annual_grants: latest.contrpdpbks ?? latest.qlfydistribtot,
    revenue: latest.totrevenue,
    filing_pdf_url: latest.pdf_url,
    propublica_name: body.organization?.name,
  };
}

function buildBrief(profile, prospect, rank) {
  const grants = Array.isArray(prospect.recent_grants) ? prospect.recent_grants.slice(0, 3) : [];
  return {
    rank,
    foundationName: prospect.name,
    ein: prospect.ein,
    snapshot: {
      location: prospect.location || "Not found in available data",
      website: prospect.website || "Not found in available data",
      foundationType: prospect.foundation_type || "Not found in available data",
      latestFilingYear: prospect.latest_filing_year || "Not found in available data",
    },
    financialCapacity: {
      assets: prospect.total_assets ? formatMoney(prospect.total_assets) : "Not found in available data",
      annualGrantsPaid: prospect.annual_grants ? formatMoney(prospect.annual_grants) : "Not found in available data",
      typicalGrantSize: prospect.typical_grant_size ? formatMoney(prospect.typical_grant_size) : "Not found in available data",
    },
    givingPattern: {
      focusAreas: prospect.focus_areas ?? "Not found in available data",
      geography: prospect.geography ?? "Not found in available data",
      recentGrants: grants.length > 0 ? grants : "Not found in available data",
    },
    fitSignals: {
      programFit: prospect.rationale,
      geographyFit: `Compared against user geography: ${text(profile.geographyServed)}`,
      askRangeFit: `Compared against desired grant size: ${text(profile.desiredGrantSize)}`,
      relationshipPath: text(profile.relationshipAssets) || "No relationship path supplied yet",
    },
    recommendedMove: {
      nextAction: nextActionFor(prospect),
      recommendedAsk: recommendedAsk(prospect, profile),
      confidence: prospect.confidence,
    },
    risk: prospect.mainRisk,
  };
}

function nextActionFor(prospect) {
  if (prospect.confidence === "High" && prospect.opennessScore >= 8) {
    return "Verify current guidelines and draft a short LOI concept.";
  }
  if (prospect.relationshipPathScore <= 3) {
    return "Map board, staff, partner, and peer-grantee relationships before outreach.";
  }
  if (prospect.confidence === "Low") {
    return "Review the latest 990-PF and funder website before keeping this in the active pipeline.";
  }
  return "Confirm application process and identify the right program contact.";
}

function recommendedAsk(prospect, profile) {
  const range = parseGrantRange(profile.desiredGrantSize);
  const typical = Number(prospect.typical_grant_size);
  if (Number.isFinite(typical) && typical > 0) {
    const low = Math.round(Math.max(range.min || typical * 0.6, typical * 0.75) / 1000) * 1000;
    const high = Math.round(Math.min(range.max || typical * 1.25, typical * 1.25) / 1000) * 1000;
    return low && high && low <= high ? `${formatMoney(low)}-${formatMoney(high)}` : formatMoney(typical);
  }
  return text(profile.desiredGrantSize) || "Set after confirming typical grant size";
}

function deadlineFor(index, confidence) {
  const days = confidence === "High" ? 14 : confidence === "Medium" ? 30 : 45;
  const date = new Date();
  date.setDate(date.getDate() + days + index);
  return date.toISOString().slice(0, 10);
}

function buildPipelineRows(profile, prospects, ownerDefault = "Unassigned") {
  return prospects.map((prospect, index) => ({
    rank: index + 1,
    foundation_name: prospect.name,
    ein: prospect.ein ?? "",
    website: prospect.website ?? "",
    hq_location: prospect.location ?? "",
    latest_filing_year: prospect.latest_filing_year ?? "",
    assets: prospect.total_assets ?? "",
    annual_grants_paid: prospect.annual_grants ?? "",
    typical_grant_size: prospect.typical_grant_size ?? "",
    program_fit_score: prospect.programFitScore,
    geography_fit_score: prospect.geographyFitScore,
    grant_size_fit_score: prospect.grantSizeFitScore,
    recency_score: prospect.recencyScore,
    openness_score: prospect.opennessScore,
    relationship_path_score: prospect.relationshipPathScore,
    total_fit_score: prospect.totalFitScore,
    confidence: prospect.confidence,
    stage: prospect.totalFitScore >= 75 ? "Outreach Prep" : prospect.totalFitScore >= 60 ? "Relationship Mapping" : "Research",
    recommended_ask: recommendedAsk(prospect, profile),
    next_action: nextActionFor(prospect),
    owner: profile.ownerNames?.[index % profile.ownerNames.length] ?? ownerDefault,
    deadline: deadlineFor(index, prospect.confidence),
    relationship_path: text(profile.relationshipAssets) || "None supplied",
    evidence_summary: prospect.rationale,
    main_risk: prospect.mainRisk,
    source_links: [prospect.website, prospect.filing_pdf_url].filter(Boolean).join(" "),
  }));
}

function csvEscape(value) {
  const string = text(value);
  if (/[",\n]/.test(string)) {
    return `"${string.replace(/"/g, '""')}"`;
  }
  return string;
}

function rowsToCsv(rows) {
  if (rows.length === 0) {
    return "";
  }
  const headers = Object.keys(rows[0]);
  return [
    headers.join(","),
    ...rows.map((row) => headers.map((header) => csvEscape(row[header])).join(",")),
  ].join("\n");
}

async function runDiscovery(body) {
  const profile = body.organizationProfile ?? {};
  const options = body.options ?? {};
  const profileCheck = checkProfile(profile);
  if (!profileCheck.ready) {
    return {
      status: "needs_more_info",
      questions: profileCheck.questions,
      missingFields: profileCheck.missingFields,
      assumptions: profileCheck.assumptions,
      summary: "The organization profile is not specific enough to produce a defensible foundation pipeline.",
    };
  }

  const { candidates, sourceNotes } = await discoverCandidates(profile, options);
  const scored = candidates
    .map((candidate) => ({ ...candidate, ...scoreProspect(profile, candidate) }))
    .sort((a, b) => b.totalFitScore - a.totalFitScore);
  const shortlistSize = clamp(Number(options.shortlistSize ?? 5), 3, 8);
  const prospects = scored.slice(0, shortlistSize);
  const briefs = prospects.map((prospect, index) => buildBrief(profile, prospect, index + 1));
  const pipelineRows = buildPipelineRows(profile, prospects, options.ownerDefault ?? "Unassigned");
  const csv = rowsToCsv(pipelineRows);
  const status = sourceNotes.some((note) => /failed/i.test(note)) ? "partial" : "complete";
  return {
    status,
    summary: `Shortlisted ${prospects.length} foundation prospects for ${profile.organizationName ?? "the organization"}. Scores are prioritization aids, not final grant strategy.`,
    prospects,
    briefs,
    pipelineRows,
    csv,
    testObservations: [
      `Profile completeness score: ${profileCheck.completenessScore}.`,
      `Strongest candidate: ${prospects[0]?.name ?? "none"}.`,
      `Lowest-confidence shortlisted candidate: ${prospects.slice().sort((a, b) => confidenceRank(a.confidence) - confidenceRank(b.confidence))[0]?.name ?? "none"}.`,
    ],
    sourceNotes: [
      ...sourceNotes,
      "Foundation filings can lag. Verify current guidelines, contact paths, and invitation status before outreach.",
    ],
  };
}

function confidenceRank(confidence) {
  return confidence === "High" ? 3 : confidence === "Medium" ? 2 : 1;
}

async function handleRoute(req, res) {
  if (req.method === "OPTIONS") {
    return sendJson(res, 204, {});
  }
  const url = new URL(req.url, `http://${req.headers.host}`);
  try {
    if (req.method === "GET" && url.pathname === "/health") {
      return sendJson(res, 200, {
        status: "ok",
        service: "funder-discovery-actions",
        mockMode: USE_MOCK_DATA,
        timestamp: new Date().toISOString(),
      });
    }
    if (req.method === "GET" && ["/openapi.json", "/.well-known/openapi.json"].includes(url.pathname)) {
      return sendJson(res, 200, openApiForRequest(req));
    }
    if (req.method === "POST" && url.pathname === "/api/intake/check") {
      const body = await readJson(req);
      return sendJson(res, 200, checkProfile(body.organizationProfile));
    }
    if (req.method === "POST" && url.pathname === "/api/funder-discovery/run") {
      const body = await readJson(req);
      return sendJson(res, 200, await runDiscovery(body));
    }
    if (req.method === "POST" && url.pathname === "/api/score") {
      const body = await readJson(req);
      const prospects = (body.prospects ?? []).map((candidate) => ({ ...candidate, ...scoreProspect(body.organizationProfile ?? {}, candidate) }));
      return sendJson(res, 200, { prospects: prospects.sort((a, b) => b.totalFitScore - a.totalFitScore) });
    }
    if (req.method === "POST" && url.pathname === "/api/pipeline/csv") {
      const body = await readJson(req);
      const rows = buildPipelineRows(body.organizationProfile ?? {}, body.prospects ?? [], body.ownerDefault ?? "Unassigned");
      return sendJson(res, 200, { pipelineRows: rows, csv: rowsToCsv(rows) });
    }
    return sendJson(res, 404, { error: "not_found", message: `No route for ${req.method} ${url.pathname}` });
  } catch (error) {
    return sendJson(res, 500, {
      error: "server_error",
      message: error instanceof Error ? error.message : String(error),
    });
  }
}

const isCli = process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;

if (isCli) {
  http.createServer(handleRoute).listen(PORT, () => {
    process.stderr.write(`Funder Discovery Actions listening on ${PORT}\n`);
  });
}

export {
  checkProfile,
  runDiscovery,
  scoreProspect,
  buildPipelineRows,
  rowsToCsv,
  openApi,
};
