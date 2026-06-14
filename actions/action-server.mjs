import http from "node:http";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { randomUUID } from "node:crypto";

const PORT = Number.parseInt(process.env.PORT ?? "8080", 10);
const DEFAULT_KINDORA_MCP_URL = "https://kindora-mcp.azurewebsites.net/mcp";
const KINDORA_MCP_URL = (process.env.KINDORA_MCP_URL ?? DEFAULT_KINDORA_MCP_URL).replace(/\/+$/, "");
const KINDORA_FALLBACK_MCP_URL = DEFAULT_KINDORA_MCP_URL;
const KINDORA_API_KEY = process.env.KINDORA_API_KEY;
const KINDORA_TIMEOUT_MS = Number.parseInt(process.env.KINDORA_TIMEOUT ?? "60000", 10);
const USE_MOCK_DATA = process.env.FUNDER_DISCOVERY_MOCK === "1";
const DEFAULT_BASE_URL = process.env.PUBLIC_BASE_URL ?? `http://localhost:${PORT}`;
const ARTIFACT_TTL_MS = 24 * 60 * 60 * 1000;
const artifacts = new Map();

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
    version: "0.5.8",
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
            content: { "application/json": { schema: { $ref: "#/components/schemas/HealthResponse" } } },
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
            content: { "application/json": { schema: { $ref: "#/components/schemas/ScoreResponse" } } },
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
            content: { "application/json": { schema: { $ref: "#/components/schemas/PipelineCsvResponse" } } },
          },
        },
      },
    },
  },
  components: {
    schemas: {
      HealthResponse: {
        type: "object",
        properties: {
          status: { type: "string" },
          service: { type: "string" },
          mockMode: { type: "boolean" },
          timestamp: { type: "string" },
        },
      },
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
          researchOnlyProspects: { type: "array", items: { type: "object", additionalProperties: true } },
          briefs: { type: "array", items: { type: "object", additionalProperties: true } },
          pipelineRows: { type: "array", items: { type: "object", additionalProperties: true } },
          downloadLinks: { $ref: "#/components/schemas/DownloadLinks" },
          downloadLinksMarkdown: { type: "string" },
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
      ScoreResponse: {
        type: "object",
        properties: {
          prospects: { type: "array", items: { $ref: "#/components/schemas/CompactProspect" } },
        },
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
      PipelineCsvResponse: {
        type: "object",
        properties: {
          pipelineRows: { type: "array", items: { type: "object", additionalProperties: true } },
          csv: { type: "string" },
          downloadLinks: { $ref: "#/components/schemas/DownloadLinks" },
        },
      },
      DownloadLinks: {
        type: "object",
        properties: {
          csv: { type: "string" },
          markdown: { type: "string" },
          xlsx: { type: "string" },
          expiresAt: { type: "string" },
        },
      },
      CompactProspect: {
        type: "object",
        additionalProperties: true,
        properties: {
          rank: { type: "integer" },
          name: { type: "string" },
          ein: { type: "string" },
          location: { type: "string" },
          website: { type: "string" },
          latest_filing_year: { type: "integer" },
          total_assets: { type: "number" },
          annual_grants: { type: "number" },
          typical_grant_size: { type: "number" },
          programFitScore: { type: "integer" },
          geographyFitScore: { type: "integer" },
          grantSizeFitScore: { type: "integer" },
          recencyScore: { type: "integer" },
          opennessScore: { type: "integer" },
          relationshipPathScore: { type: "integer" },
          totalFitScore: { type: "integer" },
          prospectCategory: { type: "string" },
          confidence: { type: "string" },
          rationale: { type: "string" },
          mainRisk: { type: "string" },
          whyNot: { type: "string" },
          recommendedAsk: { type: "string" },
          nextAction: { type: "string" },
        },
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
    geography: "New York City and national demonstration projects",
    recent_grants: [
      { recipient: "Youth Futures Network", amount: 85000, year: 2024, purpose: "Youth workforce training in New York City" },
      { recipient: "Community Pathways", amount: 65000, year: 2023, purpose: "Career readiness in New York City" },
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
      { recipient: "Digital Futures", amount: 150000, year: 2024, purpose: "Digital skills for low-income youth in New York City" },
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
    focus_areas: ["workforce readiness", "youth employment", "community opportunity"],
    geography: "New York City and national demonstration projects",
    recent_grants: [
      { recipient: "NYC Youth Career Pathways", amount: 100000, year: 2024, purpose: "Youth workforce training and job placement in New York City" },
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

function publicBaseUrlForRequest(req) {
  const forwardedProto = req.headers["x-forwarded-proto"];
  const proto = Array.isArray(forwardedProto) ? forwardedProto[0] : forwardedProto;
  return process.env.PUBLIC_BASE_URL ?? `${proto || "https"}://${req.headers.host}`;
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

function isVagueField(field, value) {
  const source = text(value).toLowerCase().replace(/[^a-z0-9 $-]/g, " ").replace(/\s+/g, " ").trim();
  if (!source) {
    return true;
  }
  if (field === "mission") {
    return /^(we )?(help|serve|support) (people|communities|everyone)$/.test(source) || source.split(/\s+/).length < 4;
  }
  if (field === "programsOrFundingNeeds") {
    return /^(grants?|funding|support|money|donations?)$/.test(source) || source.split(/\s+/).length < 3;
  }
  if (field === "geographyServed") {
    return /^(anywhere|everywhere|anywhere in the united states|all over|wherever)$/.test(source);
  }
  if (field === "beneficiaries") {
    return /^(people|everyone|communities|families|individuals)$/.test(source);
  }
  if (field === "desiredGrantSize") {
    return /^(any|any amount|whatever|as much as possible|unknown|not sure)$/.test(source);
  }
  return false;
}

function checkProfile(organizationProfile = {}) {
  const missing = requiredProfileFields
    .filter(([field]) => isBlank(organizationProfile[field]) || isVagueField(field, organizationProfile[field]))
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
    questions: questions.slice(0, 6),
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

function cleanWords(value) {
  return text(value)
    .toLowerCase()
    .replace(/[^a-z0-9 ]/g, " ")
    .split(/\s+/)
    .filter(Boolean);
}

function geographyTerms(profile) {
  const raw = text(profile.geographyServed).toLowerCase();
  const terms = raw
    .split(/[,;/]|\band\b|\bwith\b|\bplus\b/)
    .map((term) => term.trim())
    .filter((term) => term.length > 1)
    .filter((term) => !isBroadGeographyTerm(term));
  const expanded = new Set(terms);
  if (/\bnyc\b|new york city|brooklyn|bronx|queens|manhattan|staten island/.test(raw)) {
    ["new york city", "nyc"].forEach((term) => expanded.add(term));
  } else if (/\bny\b|new york/.test(raw)) {
    expanded.add("new york");
  }
  return [...expanded];
}

function isBroadGeographyTerm(term) {
  return /^(national|nationally|nationwide|united states|u s|us|usa|countrywide|regional|statewide|online|remote)\b/.test(term)
    || /\bnational\b/.test(term)
    || /\breplication partners?\b/.test(term);
}

function profileHasNationalScope(profile) {
  return /\b(?:national|nationwide|united states|u\.?s\.?|usa)\b/i.test(text(profile.geographyServed));
}

function flattenText(value) {
  if (Array.isArray(value)) {
    return value.map(flattenText).filter(Boolean).join(" ");
  }
  if (value && typeof value === "object") {
    return Object.values(value).map(flattenText).filter(Boolean).join(" ");
  }
  return value === undefined || value === null ? "" : String(value);
}

function candidateGeographyText(candidate) {
  return [
    candidate.location,
    candidate.city,
    candidate.state,
    candidate.country,
    candidate.geography,
    candidate.geographic_focus,
    candidate.funding_geography,
    candidate.funding_geographies,
    candidate.service_area,
    candidate.service_areas,
    candidate.recipient_state_distribution,
    candidate.recipient_country_distribution,
  ].map(flattenText).join(" ").toLowerCase();
}

function recentGrants(candidate) {
  return Array.isArray(candidate.recent_grants) ? candidate.recent_grants : [];
}

function grantAmount(grant) {
  const amount = Number(grant.amount ?? grant.grant_amount ?? grant.cash_amount ?? grant.value);
  return Number.isFinite(amount) ? amount : 0;
}

function grantText(grant) {
  return [
    grant.recipient,
    grant.recipient_name,
    grant.grantee,
    grant.organization_name,
    grant.city,
    grant.state,
    grant.location,
    grant.purpose,
    grant.description,
    grant.grant_purpose,
  ].map(text).join(" ").toLowerCase();
}

function grantsWithProgramEvidence(profile, candidate) {
  const words = [...keywordSet(profile)];
  return recentGrants(candidate).filter((grant) => {
    const body = grantText(grant);
    return words.filter((word) => body.includes(word)).length >= 2;
  });
}

function grantsWithGeographyEvidence(profile, candidate) {
  const terms = geographyTerms(profile);
  return recentGrants(candidate).filter((grant) => {
    const body = grantText(grant);
    return terms.some((term) => containsSearchTerm(body, term));
  });
}

function containsSearchTerm(source, term) {
  const hay = text(source).toLowerCase();
  const needle = text(term).toLowerCase().trim();
  if (!needle) {
    return false;
  }
  if (/^[a-z0-9]{2,3}$/.test(needle)) {
    return new RegExp(`\\b${needle}\\b`, "i").test(hay);
  }
  return hay.includes(needle);
}

function similarGranteeMatches(profile, candidate) {
  const programMatches = new Set(grantsWithProgramEvidence(profile, candidate));
  const geoMatches = new Set(grantsWithGeographyEvidence(profile, candidate));
  return recentGrants(candidate)
    .filter((grant) => programMatches.has(grant) || geoMatches.has(grant))
    .slice(0, 4)
    .map(compactGrant);
}

function opennessEvidence(candidate) {
  const opennessText = text(candidate.openness ?? candidate.application_process ?? candidate.guidelines ?? candidate.website ?? "").toLowerCase();
  if (/(invitation|invite only|invited|closed|family foundation|no unsolicited)/.test(opennessText)) {
    return { score: 3, status: "invitation_or_closed" };
  }
  if (/(loi|letter of inquiry|public|open|application|rfp|request for proposals|inquiry form|contact form|apply)/.test(opennessText)) {
    return { score: 14, status: "open_or_contactable" };
  }
  if (/(contact|staff|email|program officer)/.test(opennessText)) {
    return { score: 10, status: "contact_path_visible" };
  }
  return { score: 6, status: "unclear" };
}

function grantSizeEvidence(profile, candidate) {
  const range = parseGrantRange(profile.desiredGrantSize);
  const typicalGrant = Number(candidate.typical_grant_size ?? candidate.avg_grant_size ?? candidate.average_grant_size ?? candidate.median_grant_size ?? 0);
  const grantAmounts = recentGrants(candidate).map(grantAmount).filter((amount) => amount > 0);
  const hasInRangeGrant = grantAmounts.some((amount) => amount >= range.min && amount <= range.max);
  const hasNearRangeGrant = grantAmounts.some((amount) => amount >= range.min * 0.5 && amount <= range.max * 2);
  if (hasInRangeGrant) {
    return { score: 15, status: "recent_grant_in_range", typicalGrant, hasInRangeGrant, hasNearRangeGrant };
  }
  if (Number.isFinite(typicalGrant) && typicalGrant > 0) {
    if (typicalGrant >= range.min && typicalGrant <= range.max) {
      return { score: 15, status: "typical_grant_in_range", typicalGrant, hasInRangeGrant, hasNearRangeGrant };
    }
    if (typicalGrant >= range.min * 0.5 && typicalGrant <= range.max * 2) {
      return { score: 10, status: "near_range", typicalGrant, hasInRangeGrant, hasNearRangeGrant: true };
    }
    if (typicalGrant > range.max * 3 && !hasNearRangeGrant) {
      return { score: 2, status: "typical_grant_far_above_range", typicalGrant, hasInRangeGrant, hasNearRangeGrant };
    }
    if (typicalGrant < range.min * 0.5 && !hasNearRangeGrant) {
      return { score: 4, status: "typical_grant_below_range", typicalGrant, hasInRangeGrant, hasNearRangeGrant };
    }
  }
  if (hasNearRangeGrant) {
    return { score: 10, status: "recent_grant_near_range", typicalGrant, hasInRangeGrant, hasNearRangeGrant };
  }
  return { score: 5, status: "grant_size_unclear", typicalGrant, hasInRangeGrant, hasNearRangeGrant };
}

function geographyEvidence(profile, candidate) {
  const terms = geographyTerms(profile);
  const body = candidateGeographyText(candidate);
  const grantMatches = grantsWithGeographyEvidence(profile, candidate);
  const directHits = terms.filter((term) => term.length > 1 && containsSearchTerm(body, term));
  if (grantMatches.length > 0) {
    return { score: 20, status: "recent_grant_geography_match", hits: directHits, grantMatches };
  }
  if (directHits.length > 0) {
    return { score: 17, status: "profile_geography_match", hits: directHits, grantMatches };
  }
  if (profileHasNationalScope(profile) && body.includes("national")) {
    return { score: 10, status: "national_but_unconfirmed_local_fit", hits: [], grantMatches };
  }
  return { score: 3, status: "geography_not_confirmed", hits: [], grantMatches };
}

function programEvidence(profile, candidate) {
  const words = [...keywordSet(profile)];
  const candidateText = haystack(candidate);
  const matchingKeywords = words.filter((word) => candidateText.includes(word));
  const grantMatches = grantsWithProgramEvidence(profile, candidate);
  if (grantMatches.length > 0) {
    return {
      score: clamp(17 + Math.min(grantMatches.length * 3, 8), 0, 25),
      status: "recent_grant_program_match",
      matchingKeywords,
      grantMatches,
    };
  }
  if (matchingKeywords.length >= 4) {
    return { score: 18, status: "strong_profile_language_match", matchingKeywords, grantMatches };
  }
  if (matchingKeywords.length >= 2) {
    return { score: 12, status: "partial_profile_language_match", matchingKeywords, grantMatches };
  }
  return { score: 3, status: "program_fit_not_visible", matchingKeywords, grantMatches };
}

function recencyEvidence(candidate) {
  const currentYear = new Date().getFullYear();
  const latestYear = Number(candidate.latest_filing_year ?? candidate.tax_prd_yr ?? candidate.tax_year ?? 0);
  const grantYears = recentGrants(candidate).map((grant) => Number(grant.year ?? grant.tax_year ?? grant.filing_year)).filter(Number.isFinite);
  const latestGrantYear = grantYears.length > 0 ? Math.max(...grantYears) : 0;
  const latestEvidenceYear = Math.max(latestYear, latestGrantYear);
  const score = latestEvidenceYear >= currentYear - 2 ? 15 : latestEvidenceYear >= currentYear - 4 ? 10 : latestEvidenceYear > 0 ? 5 : 3;
  return { score, latestYear: latestEvidenceYear };
}

function relationshipEvidence(profile, candidate) {
  const relationshipAssets = text(profile.relationshipAssets).toLowerCase();
  if (!relationshipAssets) {
    return { score: 2, status: "no_relationship_assets_supplied" };
  }
  const tokens = cleanWords(candidate.name).filter((token) => token.length > 4);
  const hasTokenMatch = tokens.some((token) => relationshipAssets.includes(token));
  if (hasTokenMatch || /board|trustee|program officer|staff|peer grantee|funder|workforce/.test(relationshipAssets)) {
    return { score: 8, status: "relationship_path_plausible" };
  }
  return { score: 5, status: "relationship_assets_supplied_but_unmatched" };
}

function funderTypeStatus(candidate) {
  const body = text(candidate.foundation_type ?? candidate.funder_type ?? candidate.type ?? candidate.ntee_description ?? candidate.name).toLowerCase();
  if (/(operating|public charity|intermediary|council|association|jobs for the future)/.test(body)) {
    return "partnership_or_intermediary";
  }
  if (/(foundation|trust|fund|corporate giving|private foundation|family foundation|independent)/.test(body)) {
    return "grantmaker";
  }
  if (candidate.annual_grants || candidate.typical_grant_size || recentGrants(candidate).length > 0) {
    return "grantmaker_evidence";
  }
  return "unclear";
}

function qualityGateProspect(profile, candidate, evidence) {
  const disqualifiers = [];
  const cautions = [];
  const flags = {
    program: evidence.program.status,
    geography: evidence.geography.status,
    grantSize: evidence.grantSize.status,
    recency: evidence.recency.latestYear || "missing",
    openness: evidence.openness.status,
    relationship: evidence.relationship.status,
    funderType: evidence.funderType,
    similarGrantees: evidence.similarMatches.length,
  };

  if (evidence.funderType === "unclear") {
    cautions.push("Grantmaker status is unclear in available data.");
  }
  if (evidence.funderType === "partnership_or_intermediary") {
    cautions.push("May be a partnership or intermediary target rather than a direct foundation prospect.");
  }
  if (evidence.program.score < 10) {
    disqualifiers.push("Program fit is weak or not visible in recent grants.");
  }
  if (evidence.geography.score < 8) {
    disqualifiers.push("No clear geography evidence for the user's service area.");
  } else if (evidence.geography.status === "national_but_unconfirmed_local_fit") {
    cautions.push("National scope is visible, but local funding evidence is not confirmed.");
  }
  if (evidence.grantSize.status === "typical_grant_far_above_range") {
    cautions.push("Typical grant size appears far above the user's target range.");
  }
  if (evidence.grantSize.score <= 4 && evidence.grantSize.status !== "typical_grant_far_above_range") {
    cautions.push("Grant-size fit is weak or outside the requested range.");
  }
  if (evidence.recency.score <= 5) {
    cautions.push("Recent filing or grant evidence is stale or missing.");
  }
  if (evidence.openness.status === "invitation_or_closed") {
    cautions.push("Access appears invitation-only or closed.");
  }

  let prospectCategory = "direct_grant_prospect";
  if (disqualifiers.length > 0) {
    prospectCategory = "reject";
  } else if (evidence.funderType === "partnership_or_intermediary") {
    prospectCategory = "partnership_or_intermediary";
  } else if (evidence.grantSize.status === "typical_grant_far_above_range") {
    prospectCategory = evidence.relationship.score >= 8 ? "relationship_first_prospect" : "research_only";
  } else if (evidence.openness.status === "invitation_or_closed") {
    prospectCategory = "relationship_first_prospect";
  } else if (cautions.length >= 2 || evidence.similarMatches.length === 0) {
    prospectCategory = "research_only";
  }

  return {
    prospectCategory,
    disqualified: prospectCategory === "reject",
    disqualifiers,
    cautions,
    evidenceFlags: flags,
    similarGranteeMatches: evidence.similarMatches,
    whyNot: [...disqualifiers, ...cautions].slice(0, 3).join(" ") || "No major fit concern found in available data.",
  };
}

function confidenceForEvidence(gate, evidence) {
  const essentials = [
    evidence.program.score >= 17,
    evidence.geography.score >= 17,
    evidence.grantSize.score >= 10,
    evidence.recency.score >= 10,
    evidence.similarMatches.length > 0,
  ].filter(Boolean).length;
  if (gate.prospectCategory === "direct_grant_prospect" && essentials >= 4) {
    return "High";
  }
  if (["direct_grant_prospect", "relationship_first_prospect"].includes(gate.prospectCategory) && essentials >= 3) {
    return "Medium";
  }
  return "Low";
}

function scoreProspect(profile, candidate) {
  const evidence = {
    program: programEvidence(profile, candidate),
    geography: geographyEvidence(profile, candidate),
    grantSize: grantSizeEvidence(profile, candidate),
    recency: recencyEvidence(candidate),
    openness: opennessEvidence(candidate),
    relationship: relationshipEvidence(profile, candidate),
    funderType: funderTypeStatus(candidate),
    similarMatches: similarGranteeMatches(profile, candidate),
  };
  const gate = qualityGateProspect(profile, candidate, evidence);
  const totalFitScore = evidence.program.score + evidence.geography.score + evidence.grantSize.score + evidence.recency.score + evidence.openness.score + evidence.relationship.score;

  return {
    programFitScore: evidence.program.score,
    geographyFitScore: evidence.geography.score,
    grantSizeFitScore: evidence.grantSize.score,
    recencyScore: evidence.recency.score,
    opennessScore: evidence.openness.score,
    relationshipPathScore: evidence.relationship.score,
    totalFitScore,
    confidence: confidenceForEvidence(gate, evidence),
    prospectCategory: gate.prospectCategory,
    disqualified: gate.disqualified,
    disqualifiers: gate.disqualifiers,
    cautions: gate.cautions,
    evidenceFlags: gate.evidenceFlags,
    similarGranteeMatches: gate.similarGranteeMatches,
    whyNot: gate.whyNot,
    rationale: buildRationale(candidate, evidence),
    mainRisk: buildRisk(candidate, gate),
  };
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function buildRationale(candidate, evidence) {
  const parts = [];
  if (evidence.program.grantMatches.length > 0) {
    parts.push(`${evidence.program.grantMatches.length} recent grant(s) show program fit.`);
  } else if (evidence.program.matchingKeywords.length > 0) {
    parts.push(`Program language overlaps on ${evidence.program.matchingKeywords.slice(0, 5).join(", ")}.`);
  }
  if (evidence.geography.grantMatches.length > 0) {
    parts.push(`${evidence.geography.grantMatches.length} recent grant(s) show geography fit.`);
  } else if (evidence.geography.hits.length > 0) {
    parts.push(`Geography evidence mentions ${evidence.geography.hits.slice(0, 3).join(", ")}.`);
  }
  if (evidence.grantSize.typicalGrant > 0) {
    parts.push(`Typical grant size appears near ${formatMoney(evidence.grantSize.typicalGrant)}.`);
  }
  if (evidence.recency.latestYear > 0) {
    parts.push(`Latest filing or grant evidence reviewed: ${evidence.recency.latestYear}.`);
  }
  return parts.join(" ") || `Candidate has limited structured evidence and needs manual review.`;
}

function buildRisk(candidate, gate) {
  if (gate.disqualifiers.length > 0) {
    return gate.disqualifiers[0];
  }
  if (gate.cautions.length > 0) {
    return gate.cautions[0];
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

async function callKindoraTool(name, args, mcpUrl = KINDORA_MCP_URL) {
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
    const response = await fetch(mcpUrl,
    {
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

  const queries = buildSearchQueries(profile, options?.secondPassOnly ? "local" : "primary");
  const candidates = new Map();
  const sourceNotes = [];
  for (const query of queries) {
    try {
      const result = await callKindoraTool("search_funders", {
        query,
        limit: Math.min(Math.max(Number(options?.maxProspects ?? 6), 4), 8),
        exclude_funder_types: ["operating_nonprofit"],
      });
      let extracted = extractCandidates(result);
      sourceNotes.push(`${options?.secondPassOnly ? "Second-pass local" : "Primary"} Kindora search_funders query: ${query} (${extracted.length} candidate(s))`);
      if (extracted.length === 0 && KINDORA_MCP_URL !== KINDORA_FALLBACK_MCP_URL) {
        const fallbackResult = await callKindoraTool("search_funders", {
          query,
          limit: Math.min(Math.max(Number(options?.maxProspects ?? 6), 4), 8),
          exclude_funder_types: ["operating_nonprofit"],
        }, KINDORA_FALLBACK_MCP_URL);
        extracted = extractCandidates(fallbackResult);
        sourceNotes.push(`Fallback Kindora search_funders query: ${query} (${extracted.length} candidate(s))`);
      }
      for (const candidate of extracted) {
        const key = text(candidate.ein ?? candidate.EIN ?? candidate.name ?? candidate.legal_name);
        if (key && !candidates.has(key)) {
          candidates.set(key, normalizeCandidate(candidate));
        }
      }
    } catch (error) {
      sourceNotes.push(`Kindora search failed for "${query}": ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  const maxPool = options?.secondPassOnly
    ? clamp(Number(options?.maxProspects ?? 6), 4, 8)
    : clamp(Number(options?.maxProspects ?? 6) * 2, 6, 12);
  const initial = [...candidates.values()].slice(0, maxPool);
  const detailed = [];
  for (const candidate of initial) {
    detailed.push(await enrichCandidate(candidate, profile, sourceNotes));
  }
  return { candidates: detailed, sourceNotes };
}

function buildSearchQueries(profile, mode = "primary") {
  const base = [
    text(profile.programsOrFundingNeeds),
    text(profile.mission),
    text(profile.beneficiaries),
  ].filter(Boolean);
  const compact = [...new Set(base.map((item) => item.split(/[.;]/)[0].trim()).filter(Boolean))];
  const primary = compact[0] ?? "nonprofit community programs";
  const secondary = compact[1] ?? compact[0] ?? "nonprofit grants";
  const geo = text(profile.geographyServed).trim();
  const geoList = geographyTerms(profile);
  const localGeo = geoList.find((term) => term.includes("new york city")) ?? geoList[0] ?? geo;
  const programWords = [...keywordSet(profile)];
  const workforceHint = programWords.some((word) => /(workforce|career|jobs|employment|skills|training|digital)/.test(word));
  const beneficiaryHint = text(profile.beneficiaries) || "community";
  const sectorQueries = [];
  if (workforceHint) {
    sectorQueries.push("workforce development", "youth employment", "digital skills training", "career pathways");
  }
  const primaryQueries = [
    ...sectorQueries,
    primary,
    `${primary} foundation grants`.trim(),
    `${primary} ${geo}`.trim(),
    secondary,
    `${beneficiaryHint} ${primary}`.trim(),
  ];
  const localQueries = [
    `${localGeo} workforce development`.trim(),
    `${localGeo} youth employment`.trim(),
    `${localGeo} digital skills`.trim(),
    `${localGeo} ${primary} foundation grants`.trim(),
    `${localGeo} ${beneficiaryHint} grants`.trim(),
    `${localGeo} career pathways philanthropy`.trim(),
    `${localGeo} youth employment foundation grants`.trim(),
    `${localGeo} digital skills foundation grants`.trim(),
    `${localGeo} workforce development foundation grants`.trim(),
  ];
  if (workforceHint) {
    localQueries.unshift(`${localGeo} workforce training grants young adults`);
  }
  const selected = mode === "local" ? localQueries : primaryQueries;
  return [...new Set(selected.map((query) => query.replace(/\s+/g, " ").trim()).filter(Boolean))].slice(0, mode === "local" ? 6 : 5);
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
  const grants = Array.isArray(prospect.recent_grants) ? prospect.recent_grants.slice(0, 2).map(compactGrant) : [];
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
      focusAreas: compactList(prospect.focus_areas, 4) || "Not found in available data",
      geography: compactValue(prospect.geography, 240) || "Not found in available data",
      recentGrants: grants.length > 0 ? grants : "Not found in available data",
    },
    fitSignals: {
      prospectCategory: prospect.prospectCategory,
      programFit: prospect.rationale,
      geographyFit: `Compared against user geography: ${text(profile.geographyServed)}`,
      askRangeFit: `Compared against desired grant size: ${text(profile.desiredGrantSize)}`,
      relationshipPath: text(profile.relationshipAssets) || "No relationship path supplied yet",
      similarGrantees: prospect.similarGranteeMatches ?? [],
    },
    recommendedMove: {
      nextAction: nextActionFor(prospect),
      recommendedAsk: recommendedAsk(prospect, profile),
      confidence: prospect.confidence,
    },
    risk: prospect.mainRisk,
    whyNot: prospect.whyNot,
  };
}

function compactGrant(grant) {
  return {
    recipient: grant.recipient ?? grant.recipient_name ?? grant.grantee ?? grant.organization_name ?? "",
    amount: grant.amount ?? grant.grant_amount ?? "",
    year: grant.year ?? grant.tax_year ?? grant.filing_year ?? "",
    purpose: compactValue(grant.purpose ?? grant.description ?? grant.grant_purpose ?? "", 180),
  };
}

function compactList(value, limit = 5) {
  if (Array.isArray(value)) {
    return value.map((item) => compactValue(item, 80)).filter(Boolean).slice(0, limit);
  }
  if (value && typeof value === "object") {
    return Object.entries(value)
      .slice(0, limit)
      .map(([key, item]) => `${key}: ${compactValue(item, 60)}`);
  }
  return compactValue(value, 240);
}

function compactValue(value, maxLength = 240) {
  const string = text(value).replace(/\s+/g, " ").trim();
  if (string.length <= maxLength) {
    return string;
  }
  return `${string.slice(0, maxLength - 3)}...`;
}

function compactProspect(prospect, rank, profile) {
  return {
    rank,
    name: prospect.name,
    ein: prospect.ein ?? "",
    location: compactValue(prospect.location, 120),
    website: prospect.website ?? "",
    latest_filing_year: prospect.latest_filing_year ?? "",
    total_assets: prospect.total_assets ?? "",
    annual_grants: prospect.annual_grants ?? "",
    typical_grant_size: prospect.typical_grant_size ?? "",
    focus_areas: compactList(prospect.focus_areas, 4),
    geography: compactValue(prospect.geography, 200),
    sample_grants: Array.isArray(prospect.recent_grants) ? prospect.recent_grants.slice(0, 2).map(compactGrant) : [],
    programFitScore: prospect.programFitScore,
    geographyFitScore: prospect.geographyFitScore,
    grantSizeFitScore: prospect.grantSizeFitScore,
    recencyScore: prospect.recencyScore,
    opennessScore: prospect.opennessScore,
    relationshipPathScore: prospect.relationshipPathScore,
    totalFitScore: prospect.totalFitScore,
    prospectCategory: prospect.prospectCategory,
    confidence: prospect.confidence,
    evidenceFlags: prospect.evidenceFlags ?? {},
    similarGranteeMatches: prospect.similarGranteeMatches ?? [],
    rationale: compactValue(prospect.rationale, 300),
    mainRisk: compactValue(prospect.mainRisk, 220),
    whyNot: compactValue(prospect.whyNot, 260),
    recommendedAsk: recommendedAsk(prospect, profile),
    nextAction: nextActionFor(prospect),
    source_links: [prospect.website, prospect.filing_pdf_url].filter(Boolean).join(" "),
  };
}

function nextActionFor(prospect) {
  if (prospect.prospectCategory === "reject") {
    return "Do not prioritize unless new evidence resolves the disqualifier.";
  }
  if (prospect.prospectCategory === "research_only") {
    return "Verify similar grantees, geography, and application pathway before adding to active outreach.";
  }
  if (prospect.prospectCategory === "partnership_or_intermediary") {
    return "Explore partnership, cohort, or subgrant path rather than a standard foundation ask.";
  }
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
  if (prospect.prospectCategory === "reject" || prospect.prospectCategory === "research_only") {
    return "Research before setting ask";
  }
  if (prospect.prospectCategory === "partnership_or_intermediary") {
    return "Partnership or subgrant path, not direct ask";
  }
  if (Number.isFinite(typical) && typical > 0) {
    if (range.max && typical > range.max * 3 && prospect.grantSizeFitScore <= 4) {
      return `${formatMoney(range.max)} exploratory ceiling`;
    }
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
    prospect_category: prospect.prospectCategory ?? "",
    confidence: prospect.confidence,
    stage: prospect.prospectCategory === "direct_grant_prospect" && prospect.totalFitScore >= 75 ? "Outreach Prep" : prospect.prospectCategory === "relationship_first_prospect" ? "Relationship Mapping" : "Research",
    recommended_ask: recommendedAsk(prospect, profile),
    next_action: nextActionFor(prospect),
    owner: profile.ownerNames?.[index % profile.ownerNames.length] ?? ownerDefault,
    deadline: deadlineFor(index, prospect.confidence),
    relationship_path: text(profile.relationshipAssets) || "None supplied",
    evidence_summary: prospect.rationale,
    main_risk: prospect.mainRisk,
    why_not: prospect.whyNot ?? "",
    similar_grantee_matches: compactList(prospect.similarGranteeMatches, 3),
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

function buildMarkdownReport(profile, prospects, briefs, pipelineRows, sourceNotes, researchOnlyProspects = []) {
  const lines = [
    `# Funder Discovery Pipeline`,
    "",
    `Organization: ${profile.organizationName ?? "Not provided"}`,
    `Generated: ${new Date().toISOString()}`,
    "",
    "## Shortlist",
    "",
    "| Rank | Foundation | Score | Confidence | Recommended Ask | Next Action | Main Risk |",
    "|---:|---|---:|---|---|---|---|",
    ...prospects.map((prospect) => [
      prospect.rank,
      escapeMarkdownTable(prospect.name),
      prospect.totalFitScore,
      escapeMarkdownTable(prospect.confidence),
      escapeMarkdownTable(prospect.recommendedAsk),
      escapeMarkdownTable(prospect.nextAction),
      escapeMarkdownTable(prospect.mainRisk),
    ].join(" | ")).map((row) => `| ${row} |`),
    "",
    "## Research-Only Candidates",
    "",
    "| Candidate | Category | Main Reason |",
    "|---|---|---|",
    ...(researchOnlyProspects.length > 0
      ? researchOnlyProspects.map((prospect) => `| ${escapeMarkdownTable(prospect.name)} | ${escapeMarkdownTable(prospect.prospectCategory)} | ${escapeMarkdownTable(prospect.whyNot || prospect.mainRisk)} |`)
      : ["| None |  |  |"]),
    "",
    "## Funder Briefs",
    "",
  ];
  for (const brief of briefs) {
    lines.push(
      `### ${brief.rank}. ${brief.foundationName}`,
      "",
      `- EIN: ${brief.ein ?? "Not found"}`,
      `- Location: ${brief.snapshot?.location ?? "Not found"}`,
      `- Category: ${brief.fitSignals?.prospectCategory ?? "Not classified"}`,
      `- Latest filing year: ${brief.snapshot?.latestFilingYear ?? "Not found"}`,
      `- Assets: ${brief.financialCapacity?.assets ?? "Not found"}`,
      `- Annual grants paid: ${brief.financialCapacity?.annualGrantsPaid ?? "Not found"}`,
      `- Typical grant size: ${brief.financialCapacity?.typicalGrantSize ?? "Not found"}`,
      `- Fit signal: ${brief.fitSignals?.programFit ?? "Not found"}`,
      `- Recommended move: ${brief.recommendedMove?.nextAction ?? "Verify current guidelines"}`,
      `- Risk: ${brief.risk ?? "Verify before outreach"}`,
      `- Why not / caution: ${brief.whyNot ?? "No major fit concern found in available data."}`,
      "",
    );
  }
  lines.push(
    "## Pipeline Rows",
    "",
    "```csv",
    rowsToCsv(pipelineRows),
    "```",
    "",
    "## Verification Notes",
    "",
    ...sourceNotes.slice(0, 12).map((note) => `- ${note}`),
    "- Verify current foundation guidelines, application deadlines, contact paths, and invitation status before outreach.",
    "",
  );
  return lines.join("\n");
}

function escapeMarkdownTable(value) {
  return text(value).replace(/\|/g, "\\|").replace(/\n/g, " ");
}

function storeArtifacts({ profile, prospects, briefs, pipelineRows, csv, markdown, baseUrl }) {
  cleanupArtifacts();
  const id = randomUUID();
  const expiresAtDate = new Date(Date.now() + ARTIFACT_TTL_MS);
  artifacts.set(id, {
    profile,
    prospects,
    briefs,
    pipelineRows,
    csv,
    markdown,
    expiresAt: expiresAtDate.getTime(),
  });
  return {
    csv: `${baseUrl}/api/artifacts/${id}/pipeline.csv`,
    markdown: `${baseUrl}/api/artifacts/${id}/pipeline.md`,
    xlsx: `${baseUrl}/api/artifacts/${id}/pipeline.xlsx`,
    expiresAt: expiresAtDate.toISOString(),
  };
}

function formatDownloadLinks(downloadLinks) {
  return [
    `[Download XLSX](${downloadLinks.xlsx})`,
    `[Download CSV](${downloadLinks.csv})`,
    `[Download Markdown report](${downloadLinks.markdown})`,
    `Links expire at ${downloadLinks.expiresAt}.`,
  ].join("\n");
}

function cleanupArtifacts() {
  const now = Date.now();
  for (const [id, artifact] of artifacts.entries()) {
    if (artifact.expiresAt <= now) {
      artifacts.delete(id);
    }
  }
}

function artifactFromPath(pathname) {
  const match = pathname.match(/^\/api\/artifacts\/([^/]+)\/pipeline\.(csv|md|xlsx)$/);
  if (!match) {
    return null;
  }
  const artifact = artifacts.get(match[1]);
  if (!artifact || artifact.expiresAt <= Date.now()) {
    artifacts.delete(match[1]);
    return { missing: true };
  }
  return { artifact, extension: match[2] };
}

function sendDownload(req, res, contentType, filename, body) {
  const contentLength = Buffer.isBuffer(body) ? body.length : Buffer.byteLength(body);
  res.writeHead(200, {
    "content-type": contentType,
    "content-disposition": `attachment; filename="${filename}"`,
    "cache-control": "no-store",
    "content-length": String(contentLength),
    "access-control-allow-origin": "*",
  });
  if (req.method === "HEAD") {
    res.end();
    return;
  }
  res.end(body);
}

async function sendArtifact(req, res) {
  const parsed = artifactFromPath(new URL(req.url, `http://${req.headers.host}`).pathname);
  if (!parsed) {
    return false;
  }
  if (parsed.missing) {
    sendJson(res, 404, { error: "not_found", message: "Artifact link expired or does not exist." });
    return true;
  }
  if (parsed.extension === "csv") {
    sendDownload(req, res, "text/csv; charset=utf-8", "funder-pipeline.csv", parsed.artifact.csv);
    return true;
  }
  if (parsed.extension === "md") {
    sendDownload(req, res, "text/markdown; charset=utf-8", "funder-pipeline.md", parsed.artifact.markdown);
    return true;
  }
  const buffer = buildXlsx(parsed.artifact.pipelineRows);
  sendDownload(
    req,
    res,
    "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    "funder-pipeline.xlsx",
    buffer,
  );
  return true;
}

function buildXlsx(rows) {
  const headers = rows.length > 0 ? Object.keys(rows[0]) : ["pipeline"];
  const sheetRows = [headers, ...rows.map((row) => headers.map((header) => row[header] ?? ""))];
  const worksheetXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
  <sheetViews><sheetView workbookViewId="0"><pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/></sheetView></sheetViews>
  <sheetData>
${sheetRows.map((row, rowIndex) => `    <row r="${rowIndex + 1}">${row.map((cell, columnIndex) => cellXml(cell, rowIndex + 1, columnIndex + 1)).join("")}</row>`).join("\n")}
  </sheetData>
</worksheet>`;
  return zipFiles([
    {
      name: "[Content_Types].xml",
      data: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
  <Default Extension="xml" ContentType="application/xml"/>
  <Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>
  <Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>
</Types>`,
    },
    {
      name: "_rels/.rels",
      data: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>
</Relationships>`,
    },
    {
      name: "xl/workbook.xml",
      data: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
  <sheets><sheet name="Pipeline" sheetId="1" r:id="rId1"/></sheets>
</workbook>`,
    },
    {
      name: "xl/_rels/workbook.xml.rels",
      data: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/>
</Relationships>`,
    },
    { name: "xl/worksheets/sheet1.xml", data: worksheetXml },
  ]);
}

function cellXml(value, rowNumber, columnNumber) {
  const ref = `${columnName(columnNumber)}${rowNumber}`;
  if (typeof value === "number" && Number.isFinite(value)) {
    return `<c r="${ref}"><v>${value}</v></c>`;
  }
  return `<c r="${ref}" t="inlineStr"><is><t>${xmlEscape(text(value))}</t></is></c>`;
}

function columnName(number) {
  let name = "";
  let current = number;
  while (current > 0) {
    const remainder = (current - 1) % 26;
    name = String.fromCharCode(65 + remainder) + name;
    current = Math.floor((current - 1) / 26);
  }
  return name;
}

function xmlEscape(value) {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function zipFiles(files) {
  const localParts = [];
  const centralParts = [];
  let offset = 0;
  for (const file of files) {
    const name = Buffer.from(file.name);
    const data = Buffer.from(file.data);
    const crc = crc32(data);
    const localHeader = Buffer.alloc(30);
    localHeader.writeUInt32LE(0x04034b50, 0);
    localHeader.writeUInt16LE(20, 4);
    localHeader.writeUInt16LE(0, 6);
    localHeader.writeUInt16LE(0, 8);
    localHeader.writeUInt16LE(0, 10);
    localHeader.writeUInt16LE(0, 12);
    localHeader.writeUInt32LE(crc, 14);
    localHeader.writeUInt32LE(data.length, 18);
    localHeader.writeUInt32LE(data.length, 22);
    localHeader.writeUInt16LE(name.length, 26);
    localHeader.writeUInt16LE(0, 28);
    localParts.push(localHeader, name, data);

    const centralHeader = Buffer.alloc(46);
    centralHeader.writeUInt32LE(0x02014b50, 0);
    centralHeader.writeUInt16LE(20, 4);
    centralHeader.writeUInt16LE(20, 6);
    centralHeader.writeUInt16LE(0, 8);
    centralHeader.writeUInt16LE(0, 10);
    centralHeader.writeUInt16LE(0, 12);
    centralHeader.writeUInt16LE(0, 14);
    centralHeader.writeUInt32LE(crc, 16);
    centralHeader.writeUInt32LE(data.length, 20);
    centralHeader.writeUInt32LE(data.length, 24);
    centralHeader.writeUInt16LE(name.length, 28);
    centralHeader.writeUInt16LE(0, 30);
    centralHeader.writeUInt16LE(0, 32);
    centralHeader.writeUInt16LE(0, 34);
    centralHeader.writeUInt16LE(0, 36);
    centralHeader.writeUInt32LE(0, 38);
    centralHeader.writeUInt32LE(offset, 42);
    centralParts.push(centralHeader, name);
    offset += localHeader.length + name.length + data.length;
  }
  const central = Buffer.concat(centralParts);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(0, 4);
  end.writeUInt16LE(0, 6);
  end.writeUInt16LE(files.length, 8);
  end.writeUInt16LE(files.length, 10);
  end.writeUInt32LE(central.length, 12);
  end.writeUInt32LE(offset, 16);
  end.writeUInt16LE(0, 20);
  return Buffer.concat([...localParts, central, end]);
}

const crcTable = Array.from({ length: 256 }, (_, index) => {
  let value = index;
  for (let bit = 0; bit < 8; bit += 1) {
    value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
  }
  return value >>> 0;
});

function crc32(buffer) {
  let crc = 0xffffffff;
  for (const byte of buffer) {
    crc = crcTable[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

async function runDiscovery(body, baseUrl = DEFAULT_BASE_URL) {
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

  const firstPass = await discoverCandidates(profile, options);
  let candidates = firstPass.candidates;
  const sourceNotes = [...firstPass.sourceNotes];
  const shortlistSize = clamp(Number(options.shortlistSize ?? 5), 3, 8);
  let scored = rankProspects(candidates.map((candidate) => ({ ...candidate, ...scoreProspect(profile, candidate) })));
  let activeCandidates = activePipelineProspects(scored);
  if (!USE_MOCK_DATA && !options?.mockMode && activeCandidates.length < shortlistSize) {
    const secondPass = await discoverCandidates(profile, { ...options, secondPassOnly: true });
    sourceNotes.push(`Second-pass local search triggered because only ${activeCandidates.length} active prospect(s) passed the quality gate.`);
    candidates = mergeCandidates(candidates, secondPass.candidates);
    sourceNotes.push(...secondPass.sourceNotes);
    scored = rankProspects(candidates.map((candidate) => ({ ...candidate, ...scoreProspect(profile, candidate) })));
    activeCandidates = activePipelineProspects(scored);
  }
  const prospects = activeCandidates.slice(0, shortlistSize);
  const researchOnlyProspects = scored
    .filter((prospect) => !["direct_grant_prospect", "relationship_first_prospect"].includes(prospect.prospectCategory))
    .slice(0, 8);
  const briefs = prospects.map((prospect, index) => buildBrief(profile, prospect, index + 1));
  const pipelineRows = buildPipelineRows(profile, prospects, options.ownerDefault ?? "Unassigned");
  const csv = rowsToCsv(pipelineRows);
  const status = sourceNotes.some((note) => /failed/i.test(note)) || prospects.length < 3 ? "partial" : "complete";
  const compactProspects = prospects.map((prospect, index) => compactProspect(prospect, index + 1, profile));
  const compactResearchOnly = researchOnlyProspects.map((prospect, index) => compactProspect(prospect, index + 1, profile));
  const cappedSourceNotes = [
    ...sourceNotes.slice(0, 12),
    "Foundation filings can lag. Verify current guidelines, contact paths, and invitation status before outreach.",
  ];
  const markdown = buildMarkdownReport(profile, compactProspects, briefs, pipelineRows, cappedSourceNotes, compactResearchOnly);
  const downloadLinks = storeArtifacts({
    profile,
    prospects: compactProspects,
    researchOnlyProspects: compactResearchOnly,
    briefs,
    pipelineRows,
    csv,
    markdown,
    baseUrl,
  });
  return {
    status,
    summary: `Shortlisted ${prospects.length} foundation prospects for ${profile.organizationName ?? "the organization"}. Scores are prioritization aids, not final grant strategy.`,
    prospects: compactProspects,
    researchOnlyProspects: compactResearchOnly,
    briefs,
    pipelineRows,
    downloadLinks,
    downloadLinksMarkdown: formatDownloadLinks(downloadLinks),
    testObservations: [
      `Profile completeness score: ${profileCheck.completenessScore}.`,
      `Strongest candidate: ${prospects[0]?.name ?? "none"}.`,
      `Active prospects passing quality gate: ${activeCandidates.length}.`,
      `Research-only or rejected candidates: ${researchOnlyProspects.length}.`,
      `Lowest-confidence shortlisted candidate: ${prospects.slice().sort((a, b) => confidenceRank(a.confidence) - confidenceRank(b.confidence))[0]?.name ?? "none"}.`,
    ],
    sourceNotes: cappedSourceNotes,
  };
}

function mergeCandidates(primary, secondary) {
  const merged = new Map();
  for (const candidate of [...primary, ...secondary]) {
    const key = text(candidate.ein ?? candidate.EIN ?? candidate.name ?? candidate.legal_name);
    if (key && !merged.has(key)) {
      merged.set(key, candidate);
    }
  }
  return [...merged.values()];
}

function rankProspects(prospects) {
  return prospects.sort((a, b) => {
    const categoryDelta = categoryRank(a.prospectCategory) - categoryRank(b.prospectCategory);
    if (categoryDelta !== 0) {
      return categoryDelta;
    }
    return b.totalFitScore - a.totalFitScore;
  });
}

function categoryRank(category) {
  return {
    direct_grant_prospect: 0,
    relationship_first_prospect: 1,
    partnership_or_intermediary: 2,
    research_only: 3,
    reject: 4,
  }[category] ?? 5;
}

function activePipelineProspects(prospects) {
  return prospects.filter((prospect) => ["direct_grant_prospect", "relationship_first_prospect"].includes(prospect.prospectCategory));
}

function confidenceRank(confidence) {
  return confidence === "High" ? 3 : confidence === "Medium" ? 2 : 1;
}

async function handleRoute(req, res) {
  if (req.method === "OPTIONS") {
    return sendJson(res, 204, {});
  }
  if ((req.method === "GET" || req.method === "HEAD") && await sendArtifact(req, res)) {
    return;
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
      return sendJson(res, 200, await runDiscovery(body, publicBaseUrlForRequest(req)));
    }
    if (req.method === "POST" && url.pathname === "/api/score") {
      const body = await readJson(req);
      const prospects = rankProspects(
        (body.prospects ?? []).map((candidate) => ({ ...candidate, ...scoreProspect(body.organizationProfile ?? {}, candidate) })),
      )
        .map((prospect, index) => compactProspect(prospect, index + 1, body.organizationProfile ?? {}));
      return sendJson(res, 200, { prospects });
    }
    if (req.method === "POST" && url.pathname === "/api/pipeline/csv") {
      const body = await readJson(req);
      const rows = buildPipelineRows(body.organizationProfile ?? {}, body.prospects ?? [], body.ownerDefault ?? "Unassigned");
      const csv = rowsToCsv(rows);
      const markdown = buildMarkdownReport(body.organizationProfile ?? {}, body.prospects ?? [], [], rows, []);
      const downloadLinks = storeArtifacts({
        profile: body.organizationProfile ?? {},
        prospects: body.prospects ?? [],
        briefs: [],
        pipelineRows: rows,
        csv,
        markdown,
        baseUrl: publicBaseUrlForRequest(req),
      });
      return sendJson(res, 200, { pipelineRows: rows, csv, downloadLinks });
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
  buildXlsx,
  rowsToCsv,
  openApi,
};
