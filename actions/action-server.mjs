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
const KINDORA_SEARCH_TIMEOUT_MS = Number.parseInt(process.env.KINDORA_SEARCH_TIMEOUT ?? "12000", 10);
const KINDORA_DETAIL_TIMEOUT_MS = Number.parseInt(process.env.KINDORA_DETAIL_TIMEOUT ?? "15000", 10);
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
    version: "0.6.7",
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
          peerOrganizations: { type: "array", items: { type: "string" } },
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
              disableRegionalFallback: { type: "boolean", default: false },
              disableCauseFallback: { type: "boolean", default: false },
              causeFallbackOnly: { type: "boolean", default: false },
              regionalFallbackOnly: { type: "boolean", default: false },
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

const regionalFallbackCatalog = {
  triangle_nc: {
    label: "Raleigh-Durham Triangle, North Carolina",
    aliases: [/raleigh/i, /durham/i, /cary/i, /wake county/i, /triangle region/i, /\btriangle\b/i, /north carolina/i, /\bnc\b/i],
    candidates: [
      {
        name: "The Robert P. Holding Foundation",
        location: "Raleigh, NC",
        geography: "Raleigh, Wake County, and North Carolina",
        focus_areas: ["youth development", "education", "community services", "family support"],
        typical_grant_size: 100000,
        latest_filing_year: 2024,
        guidelineStatus: "Regional seed from user-provided benchmark data. Verify current application process before outreach.",
        invitationStatus: "Verify whether applications are open or relationship-led.",
        grantSizeFitNote: "Benchmark data showed multiple grants to YMCA of the Triangle, including a 2024 latest-year total above the requested range. A $50,000-$150,000 request may still be plausible if scoped tightly.",
        recent_grants: [
          {
            recipient: "YMCA of the Triangle Area",
            amount: 334000,
            year: 2024,
            purpose: "Benchmark foundation funding signal for YMCA of the Triangle Area youth development, camp, swim safety, and family programs.",
            source: "User-provided benchmark screenshot, 2026-06-14",
          },
        ],
      },
      {
        name: "A. E. Finley Foundation",
        location: "Raleigh, NC",
        geography: "Raleigh, Wake County, and North Carolina",
        focus_areas: ["youth development", "education", "health", "community services"],
        typical_grant_size: 100000,
        latest_filing_year: 2024,
        guidelineStatus: "Regional seed from user-provided benchmark data. Verify current guidelines and fit.",
        invitationStatus: "Verify current access path.",
        grantSizeFitNote: "Benchmark data showed six grants to YMCA of the Triangle and a 2024 latest-year total near the requested range.",
        recent_grants: [
          {
            recipient: "YMCA of the Triangle Area",
            amount: 129000,
            year: 2024,
            purpose: "Benchmark foundation funding signal for YMCA of the Triangle Area youth development, camp, swim safety, and family programs.",
            source: "User-provided benchmark screenshot, 2026-06-14",
          },
        ],
      },
      {
        name: "United Way of the Greater Triangle",
        location: "Raleigh, NC",
        geography: "Triangle region of North Carolina",
        focus_areas: ["youth opportunity", "basic needs", "education", "community services"],
        typical_grant_size: 100000,
        latest_filing_year: 2023,
        guidelineStatus: "Regional seed from user-provided benchmark data. Verify current partnership and grant process.",
        invitationStatus: "May be campaign or partnership driven. Confirm before outreach.",
        grantSizeFitNote: "Benchmark data showed a latest-year total within the requested range.",
        recent_grants: [
          {
            recipient: "YMCA of the Triangle Area",
            amount: 119000,
            year: 2023,
            purpose: "Benchmark foundation funding signal for YMCA of the Triangle Area youth development, camp, swim safety, and family programs.",
            source: "User-provided benchmark screenshot, 2026-06-14",
          },
        ],
      },
      {
        name: "ChildTrust Foundation",
        location: "North Carolina",
        geography: "Raleigh, Wake County, Triangle-area communities, and North Carolina",
        focus_areas: ["children", "youth development", "family support", "education"],
        typical_grant_size: 100000,
        latest_filing_year: 2024,
        guidelineStatus: "Regional seed from user-provided benchmark data. Verify current guidelines.",
        invitationStatus: "Verify whether unsolicited requests are accepted.",
        grantSizeFitNote: "Benchmark data showed three grants to YMCA of the Triangle and a latest-year total inside the requested range.",
        recent_grants: [
          {
            recipient: "YMCA of the Triangle Area",
            amount: 100000,
            year: 2024,
            purpose: "Benchmark foundation funding signal for YMCA of the Triangle Area youth development, camp, swim safety, and family programs.",
            source: "User-provided benchmark screenshot, 2026-06-14",
          },
        ],
      },
      {
        name: "The Cannon Foundation",
        location: "Concord, NC",
        website: "https://www.cannonfoundation.org/",
        geography: "Raleigh, Wake County, Triangle region, and North Carolina",
        focus_areas: ["human services", "education", "health", "community facilities", "youth development"],
        typical_grant_size: 50000,
        latest_filing_year: 2024,
        guidelineStatus: "Regional seed from user-provided benchmark data. Verify current guidelines and eligibility.",
        invitationStatus: "Verify current application process.",
        grantSizeFitNote: "Benchmark data showed a 2024 grant amount at the lower end of the requested range.",
        recent_grants: [
          {
            recipient: "YMCA of the Triangle Area",
            amount: 50000,
            year: 2024,
            purpose: "Benchmark foundation funding signal for YMCA of the Triangle Area youth development, camp, swim safety, and family programs.",
            source: "User-provided benchmark screenshot, 2026-06-14",
          },
        ],
      },
    ],
  },
  nyc: {
    label: "New York City",
    aliases: [/new york city/i, /\bnyc\b/i, /brooklyn|bronx|queens|manhattan|staten island/i],
    candidates: [
      {
        name: "The New York Community Trust",
        location: "New York, NY",
        website: "https://www.nycommunitytrust.org/",
        geography: "New York City",
        focus_areas: ["workforce development", "youth opportunity", "education", "economic mobility"],
      },
      {
        name: "Robin Hood Foundation",
        location: "New York, NY",
        website: "https://www.robinhood.org/",
        geography: "New York City",
        focus_areas: ["poverty", "jobs", "economic mobility", "youth opportunity"],
      },
      {
        name: "The Pinkerton Foundation",
        location: "New York, NY",
        website: "https://www.thepinkertonfoundation.org/",
        geography: "New York City",
        focus_areas: ["youth development", "career readiness", "education", "employment"],
      },
      {
        name: "Altman Foundation",
        location: "New York, NY",
        website: "https://www.altmanfoundation.org/",
        geography: "New York City",
        focus_areas: ["education", "workforce development", "youth", "economic security"],
      },
      {
        name: "Tiger Foundation",
        location: "New York, NY",
        website: "https://www.tigerfoundation.org/",
        geography: "New York City",
        focus_areas: ["poverty", "youth", "education", "employment"],
      },
    ],
  },
  dc: {
    label: "Washington, DC",
    aliases: [/washington,\s*dc/i, /washington dc/i, /\bdc\b/i, /district of columbia/i],
    candidates: [
      {
        name: "Greater Washington Community Foundation",
        location: "Washington, DC",
        website: "https://www.thecommunityfoundation.org/",
        geography: "Washington, DC and Greater Washington",
        focus_areas: ["economic mobility", "workforce development", "education", "community opportunity"],
      },
      {
        name: "The Morris and Gwendolyn Cafritz Foundation",
        location: "Washington, DC",
        website: "https://www.cafritzfoundation.org/",
        geography: "Washington, DC metropolitan region",
        focus_areas: ["community services", "education", "youth", "workforce"],
      },
      {
        name: "The Meyer Foundation",
        location: "Washington, DC",
        website: "https://www.meyerfoundation.org/",
        geography: "Washington, DC region",
        focus_areas: ["equity", "economic justice", "community power", "nonprofit capacity"],
      },
    ],
  },
  sf: {
    label: "San Francisco Bay Area",
    aliases: [/san francisco/i, /\bsf\b/i, /bay area/i, /oakland/i, /silicon valley/i],
    candidates: [
      {
        name: "San Francisco Foundation",
        location: "San Francisco, CA",
        website: "https://sff.org/",
        geography: "San Francisco Bay Area",
        focus_areas: ["economic mobility", "jobs", "education", "community power"],
      },
      {
        name: "Tipping Point Community",
        location: "San Francisco, CA",
        website: "https://tippingpoint.org/",
        geography: "San Francisco Bay Area",
        focus_areas: ["poverty", "employment", "education", "youth"],
      },
      {
        name: "Walter and Elise Haas Fund",
        location: "San Francisco, CA",
        website: "https://haassr.org/",
        geography: "San Francisco Bay Area",
        focus_areas: ["economic security", "education", "youth development", "community"],
      },
      {
        name: "Zellerbach Family Foundation",
        location: "San Francisco, CA",
        website: "https://zff.org/",
        geography: "San Francisco Bay Area",
        focus_areas: ["community arts", "immigrant communities", "youth", "equity"],
      },
    ],
  },
  la: {
    label: "Los Angeles",
    aliases: [/los angeles/i, /\bla\b/i, /southern california/i],
    candidates: [
      {
        name: "California Community Foundation",
        location: "Los Angeles, CA",
        website: "https://www.calfund.org/",
        geography: "Los Angeles County",
        focus_areas: ["education", "youth", "economic mobility", "community opportunity"],
      },
      {
        name: "Weingart Foundation",
        location: "Los Angeles, CA",
        website: "https://weingartfnd.org/",
        geography: "Southern California",
        focus_areas: ["equity", "poverty", "nonprofit capacity", "community opportunity"],
      },
      {
        name: "Annenberg Foundation",
        location: "Los Angeles, CA",
        website: "https://annenberg.org/",
        geography: "Los Angeles and Southern California",
        focus_areas: ["education", "youth", "community", "opportunity"],
      },
    ],
  },
  chicago: {
    label: "Chicago",
    aliases: [/chicago/i, /cook county/i],
    candidates: [
      {
        name: "The Chicago Community Trust",
        location: "Chicago, IL",
        website: "https://www.cct.org/",
        geography: "Chicago region",
        focus_areas: ["economic opportunity", "education", "workforce", "community development"],
      },
      {
        name: "Polk Bros. Foundation",
        location: "Chicago, IL",
        website: "https://www.polkbrosfdn.org/",
        geography: "Chicago",
        focus_areas: ["youth", "education", "employment", "basic needs"],
      },
      {
        name: "The Field Foundation of Illinois",
        location: "Chicago, IL",
        website: "https://fieldfoundation.org/",
        geography: "Chicago",
        focus_areas: ["justice", "community", "youth", "leadership"],
      },
    ],
  },
  boston: {
    label: "Boston",
    aliases: [/boston/i, /greater boston/i, /massachusetts/i],
    candidates: [
      {
        name: "The Boston Foundation",
        location: "Boston, MA",
        website: "https://www.tbf.org/",
        geography: "Greater Boston",
        focus_areas: ["education", "jobs", "economic mobility", "community"],
      },
      {
        name: "Barr Foundation",
        location: "Boston, MA",
        website: "https://www.barrfoundation.org/",
        geography: "Boston and Massachusetts",
        focus_areas: ["education", "youth", "climate", "arts"],
      },
      {
        name: "Hyams Foundation",
        location: "Boston, MA",
        website: "https://hyamsfoundation.org/",
        geography: "Boston and Chelsea",
        focus_areas: ["economic justice", "youth", "community power", "education"],
      },
    ],
  },
  seattle: {
    label: "Seattle",
    aliases: [/seattle/i, /king county/i, /puget sound/i],
    candidates: [
      {
        name: "Seattle Foundation",
        location: "Seattle, WA",
        website: "https://www.seattlefoundation.org/",
        geography: "Seattle and King County",
        focus_areas: ["equity", "economic opportunity", "youth", "community"],
      },
      {
        name: "Raikes Foundation",
        location: "Seattle, WA",
        website: "https://raikesfoundation.org/",
        geography: "Washington State and national systems work",
        focus_areas: ["youth", "education", "postsecondary success", "economic mobility"],
      },
      {
        name: "Ballmer Group",
        location: "Bellevue, WA",
        website: "https://www.ballmergroup.org/",
        geography: "Washington State and national",
        focus_areas: ["economic mobility", "youth", "workforce", "community"],
      },
    ],
  },
  atlanta: {
    label: "Atlanta",
    aliases: [/atlanta/i, /georgia/i, /fulton county/i],
    candidates: [
      {
        name: "Community Foundation for Greater Atlanta",
        location: "Atlanta, GA",
        website: "https://cfgreateratlanta.org/",
        geography: "Greater Atlanta",
        focus_areas: ["equity", "education", "economic mobility", "community"],
      },
      {
        name: "Arthur M. Blank Family Foundation",
        location: "Atlanta, GA",
        website: "https://blankfoundation.org/",
        geography: "Atlanta and Georgia",
        focus_areas: ["youth development", "democracy", "environment", "community"],
      },
      {
        name: "Joseph B. Whitehead Foundation",
        location: "Atlanta, GA",
        website: "https://www.woodruff.org/",
        geography: "Atlanta and Georgia",
        focus_areas: ["education", "health", "human services", "community"],
      },
    ],
  },
  philadelphia: {
    label: "Philadelphia",
    aliases: [/philadelphia/i, /\bphilly\b/i],
    candidates: [
      {
        name: "The Philadelphia Foundation",
        location: "Philadelphia, PA",
        website: "https://www.philafound.org/",
        geography: "Greater Philadelphia",
        focus_areas: ["community", "equity", "education", "economic opportunity"],
      },
      {
        name: "William Penn Foundation",
        location: "Philadelphia, PA",
        website: "https://williampennfoundation.org/",
        geography: "Philadelphia region",
        focus_areas: ["children", "education", "public space", "community"],
      },
      {
        name: "Barra Foundation",
        location: "Wayne, PA",
        website: "https://www.barrafoundation.org/",
        geography: "Greater Philadelphia",
        focus_areas: ["innovation", "human services", "youth", "community"],
      },
    ],
  },
  miami: {
    label: "Miami",
    aliases: [/miami/i, /south florida/i, /miami-dade/i],
    candidates: [
      {
        name: "The Miami Foundation",
        location: "Miami, FL",
        website: "https://miamifoundation.org/",
        geography: "Miami-Dade County",
        focus_areas: ["equity", "economic opportunity", "community", "youth"],
      },
      {
        name: "The Children's Trust",
        location: "Miami, FL",
        website: "https://www.thechildrenstrust.org/",
        geography: "Miami-Dade County",
        focus_areas: ["children", "youth", "education", "family support"],
      },
      {
        name: "Knight Foundation",
        location: "Miami, FL",
        website: "https://knightfoundation.org/",
        geography: "Miami and selected U.S. communities",
        focus_areas: ["community", "journalism", "arts", "technology"],
      },
    ],
  },
  dallas: {
    label: "Dallas",
    aliases: [/dallas/i, /north texas/i, /fort worth/i],
    candidates: [
      {
        name: "Communities Foundation of Texas",
        location: "Dallas, TX",
        website: "https://www.cftexas.org/",
        geography: "North Texas",
        focus_areas: ["education", "economic security", "community", "youth"],
      },
      {
        name: "The Meadows Foundation",
        location: "Dallas, TX",
        website: "https://www.mfi.org/",
        geography: "Texas",
        focus_areas: ["education", "human services", "civic", "community"],
      },
      {
        name: "Lyda Hill Philanthropies",
        location: "Dallas, TX",
        website: "https://lydahillphilanthropies.org/",
        geography: "North Texas and selected national initiatives",
        focus_areas: ["science", "nature", "community", "women and girls"],
      },
    ],
  },
};

const causeFallbackCatalog = [
  {
    id: "nonprofit_technology_infrastructure",
    label: "nonprofit technology and fundraising infrastructure deterministic fallback",
    triggers: [
      /techsoup/i,
      /network for good/i,
      /nonprofit technology/i,
      /digital capacity/i,
      /fundraising infrastructure/i,
      /donor infrastructure/i,
      /technology access/i,
      /nonprofit capacity/i,
    ],
    candidates: [
      {
        name: "Bill & Melinda Gates Foundation",
        location: "Seattle, WA",
        website: "https://www.gatesfoundation.org/",
        geography: "Washington, DC, United States, and global nonprofit infrastructure",
        focus_areas: ["nonprofit technology", "digital public infrastructure", "philanthropy infrastructure", "capacity building"],
        typical_grant_size: 500000,
        latest_filing_year: 2024,
        guidelineStatus: "Benchmark direct-funder signal for Network for Good. Verify current program strategy and whether nonprofit technology infrastructure is an active fit.",
        invitationStatus: "Often strategy-led or relationship-driven outside formal open calls.",
        grantSizeFitNote: "Benchmark data showed a $1,000,000 latest-year total, above the requested range. A smaller ask needs a tight learning, infrastructure, or scaling rationale.",
        recent_grants: [
          {
            recipient: "Network for Good",
            amount: 1000000,
            year: 2024,
            purpose: "Benchmark foundation funding signal for Network for Good nonprofit technology, online giving, and fundraising infrastructure.",
            source: "User-provided benchmark screenshot, 2026-06-14",
          },
        ],
      },
      {
        name: "Every.org",
        location: "United States",
        website: "https://www.every.org/",
        geography: "Washington, DC, United States nonprofit giving infrastructure",
        focus_areas: ["online giving", "donor infrastructure", "nonprofit technology", "fundraising infrastructure"],
        typical_grant_size: 250000,
        latest_filing_year: 2024,
        guidelineStatus: "Benchmark direct-funder signal for Network for Good. Verify whether this is a grantmaker, platform partner, or infrastructure collaborator in the current context.",
        invitationStatus: "Verify current partnership or grant access path.",
        grantSizeFitNote: "Benchmark data showed three grants and a latest-year total near the requested range.",
        recent_grants: [
          {
            recipient: "Network for Good",
            amount: 475000,
            year: 2024,
            purpose: "Benchmark funding signal for Network for Good nonprofit technology, online giving, and fundraising infrastructure.",
            source: "User-provided benchmark screenshot, 2026-06-14",
          },
        ],
      },
      {
        name: "GlobalGiving Foundation",
        location: "Washington, DC",
        website: "https://www.globalgiving.org/",
        geography: "Washington, DC, United States and global nonprofit giving infrastructure",
        focus_areas: ["online giving", "nonprofit capacity", "fundraising infrastructure", "digital giving"],
        typical_grant_size: 150000,
        latest_filing_year: 2023,
        guidelineStatus: "Benchmark direct-funder signal for Network for Good. Verify current role as grantmaker, platform, or partner.",
        invitationStatus: "Verify current access path.",
        grantSizeFitNote: "Benchmark data showed a latest-year total inside the requested range.",
        recent_grants: [
          {
            recipient: "Network for Good",
            amount: 146000,
            year: 2023,
            purpose: "Benchmark foundation funding signal for Network for Good nonprofit technology, online giving, and fundraising infrastructure.",
            source: "User-provided benchmark screenshot, 2026-06-14",
          },
        ],
      },
      {
        name: "The Old Oak Foundation",
        location: "United States",
        geography: "Washington, DC, United States",
        focus_areas: ["nonprofit capacity", "digital equity", "community services", "technology access"],
        typical_grant_size: 75000,
        latest_filing_year: 2024,
        guidelineStatus: "Benchmark direct-funder signal for Network for Good. Verify current guidelines and program fit.",
        invitationStatus: "Verify whether requests are open or relationship-led.",
        grantSizeFitNote: "Benchmark data showed two grants and a latest-year total inside the requested range.",
        recent_grants: [
          {
            recipient: "Network for Good",
            amount: 72000,
            year: 2024,
            purpose: "Benchmark foundation funding signal for Network for Good nonprofit technology, online giving, and fundraising infrastructure.",
            source: "User-provided benchmark screenshot, 2026-06-14",
          },
        ],
      },
      {
        name: "Knight Foundation",
        location: "Miami, FL",
        website: "https://knightfoundation.org/",
        geography: "Washington, DC, United States and selected communities",
        focus_areas: ["technology", "civic information", "digital transformation", "community infrastructure"],
        typical_grant_size: 200000,
        guidelineStatus: "New-candidate seed for nonprofit technology and civic infrastructure. Verify whether the current strategy fits nonprofit fundraising or technology capacity.",
        invitationStatus: "Often program-led. Verify open calls and staff fit.",
        grantSizeFitNote: "A $50,000-$250,000 request may fit only if aligned with a current technology, civic information, or community-infrastructure priority.",
        peerSignals: ["TechSoup", "NTEN", "digital equity intermediaries", "nonprofit technology capacity organizations"],
      },
      {
        name: "Omidyar Network",
        location: "Redwood City, CA",
        website: "https://omidyar.com/",
        geography: "Washington, DC, United States and global",
        focus_areas: ["digital society", "technology for public good", "philanthropy infrastructure", "responsible technology"],
        typical_grant_size: 250000,
        guidelineStatus: "New-candidate seed for digital civil society and technology infrastructure. Verify current funding vehicles and whether grants are made directly to U.S. nonprofits.",
        invitationStatus: "Usually relationship-led.",
        grantSizeFitNote: "The requested range may fit a scoped infrastructure or field-building project, subject to current priorities.",
        peerSignals: ["nonprofit technology intermediaries", "digital public infrastructure organizations", "civil society technology groups"],
      },
    ],
  },
  {
    id: "digital_agriculture_smallholder",
    label: "digital agriculture and smallholder farmer deterministic fallback",
    triggers: [
      /digital green/i,
      /farmerchat/i,
      /smallholder/i,
      /small-scale farmer/i,
      /digital agriculture/i,
      /climate-smart agriculture/i,
      /agricultural advice/i,
      /farmer livelihoods/i,
      /extension partners/i,
    ],
    candidates: [
      {
        name: "Bill & Melinda Gates Foundation",
        location: "Seattle, WA",
        website: "https://www.gatesfoundation.org/",
        geography: "Global agriculture and low- and middle-income countries",
        focus_areas: ["agricultural development", "smallholder farmers", "digital agriculture", "food systems"],
        typical_grant_size: 1000000,
        latest_filing_year: 2024,
        guidelineStatus: "Benchmark direct-funder signal for Digital Green. Verify current agricultural development strategy, country fit, and invitation path.",
        invitationStatus: "Often strategy-led or RFP-driven.",
        grantSizeFitNote: "Benchmark data showed multiple grants to Digital Green, including a 2024 latest-year total above the requested range. A $250,000-$1,000,000 request may fit if scoped to a priority geography or learning agenda.",
        recent_grants: [
          {
            recipient: "Digital Green Foundation",
            amount: 1500000,
            year: 2024,
            purpose: "Benchmark foundation funding signal for Digital Green Foundation digital agriculture, smallholder farmer, climate-smart agriculture, and farmer livelihood work.",
            source: "User-provided benchmark screenshot, 2026-06-14",
          },
        ],
      },
      {
        name: "Walmart Foundation",
        location: "Bentonville, AR",
        website: "https://www.walmart.org/",
        geography: "United States and global supply chains",
        focus_areas: ["smallholder farmers", "market access", "food systems", "livelihoods"],
        typical_grant_size: 1000000,
        latest_filing_year: 2023,
        guidelineStatus: "Benchmark direct-funder signal for Digital Green. Verify current agriculture and supply-chain philanthropy priorities.",
        invitationStatus: "Likely program-led. Verify current guidelines.",
        grantSizeFitNote: "Benchmark data showed a large latest-year grant. A request in the user's range should be framed around farmer livelihoods, market access, or food-system outcomes.",
        recent_grants: [
          {
            recipient: "Digital Green Foundation",
            amount: 3000000,
            year: 2023,
            purpose: "Benchmark foundation funding signal for Digital Green Foundation digital agriculture, smallholder farmer, climate-smart agriculture, and farmer livelihood work.",
            source: "User-provided benchmark screenshot, 2026-06-14",
          },
        ],
      },
      {
        name: "Mulago Foundation",
        location: "San Francisco, CA",
        website: "https://www.mulagofoundation.org/",
        geography: "Organizations serving people in poverty globally",
        focus_areas: ["poverty", "smallholder farmers", "livelihoods", "scalable delivery models"],
        typical_grant_size: 500000,
        latest_filing_year: 2024,
        guidelineStatus: "Benchmark direct-funder signal for Digital Green. Verify current fit and introduction pathway.",
        invitationStatus: "Relationship-driven. Warm path matters.",
        grantSizeFitNote: "Benchmark data showed two grants to Digital Green and a latest-year total in the requested range.",
        recent_grants: [
          {
            recipient: "Digital Green Foundation",
            amount: 500000,
            year: 2024,
            purpose: "Benchmark foundation funding signal for Digital Green Foundation digital agriculture, smallholder farmer, climate-smart agriculture, and farmer livelihood work.",
            source: "User-provided benchmark screenshot, 2026-06-14",
          },
        ],
      },
      {
        name: "The Rockefeller Foundation",
        location: "New York, NY",
        website: "https://www.rockefellerfoundation.org/",
        geography: "Global food systems and climate resilience",
        focus_areas: ["food systems", "climate-smart agriculture", "smallholder farmers", "livelihoods"],
        typical_grant_size: 500000,
        latest_filing_year: 2024,
        guidelineStatus: "Benchmark direct-funder signal for Digital Green. Verify current food and climate strategy fit.",
        invitationStatus: "Often relationship or strategy-led.",
        grantSizeFitNote: "Benchmark data showed two grants and a latest-year total in the requested range.",
        recent_grants: [
          {
            recipient: "Digital Green Foundation",
            amount: 469000,
            year: 2024,
            purpose: "Benchmark foundation funding signal for Digital Green Foundation digital agriculture, smallholder farmer, climate-smart agriculture, and farmer livelihood work.",
            source: "User-provided benchmark screenshot, 2026-06-14",
          },
        ],
      },
      {
        name: "Patrick J. McGovern Foundation",
        location: "Boston, MA",
        website: "https://www.mcgovern.org/",
        geography: "Global and United States, with emphasis on AI and data for social impact",
        focus_areas: ["AI for good", "data science", "digital public goods", "agriculture technology"],
        typical_grant_size: 400000,
        latest_filing_year: 2024,
        guidelineStatus: "Benchmark direct-funder signal for Digital Green. Verify whether FarmerChat fits current AI and data-for-good priorities.",
        invitationStatus: "Likely inquiry or relationship-led. Confirm before outreach.",
        grantSizeFitNote: "Benchmark data showed a latest-year grant in the requested range.",
        recent_grants: [
          {
            recipient: "Digital Green Foundation",
            amount: 400000,
            year: 2024,
            purpose: "Benchmark foundation funding signal for Digital Green Foundation digital agriculture, smallholder farmer, climate-smart agriculture, and farmer livelihood work.",
            source: "User-provided benchmark screenshot, 2026-06-14",
          },
        ],
      },
      {
        name: "IKEA Foundation",
        location: "Netherlands",
        website: "https://ikeafoundation.org/",
        geography: "Global South and climate-vulnerable communities",
        focus_areas: ["livelihoods", "climate resilience", "smallholder farmers", "agricultural systems"],
        typical_grant_size: 750000,
        latest_filing_year: 2024,
        guidelineStatus: "New-candidate seed for climate-smart agriculture and livelihoods. Verify current geography, open calls, and whether U.S. nonprofit applicants are eligible.",
        invitationStatus: "Often strategy-led and partnership-driven.",
        grantSizeFitNote: "A $250,000-$1,000,000 request may fit if tied to farmer livelihoods, climate adaptation, or systems partnerships.",
        peerSignals: ["One Acre Fund", "Root Capital", "climate-smart agriculture implementers", "smallholder livelihood organizations"],
        peerGrantEvidence: [
          {
            recipient: "One Acre Fund",
            amount: "",
            year: 2024,
            purpose: "Co-funded peer signal from the Digital Green benchmark screenshot for smallholder farmer and agricultural livelihood work.",
            source: "User-provided Digital Green benchmark screenshot, 2026-06-14",
          },
          {
            recipient: "Root Capital",
            amount: "",
            year: 2024,
            purpose: "Co-funded peer signal from the Digital Green benchmark screenshot for smallholder farmer and agricultural livelihood work.",
            source: "User-provided Digital Green benchmark screenshot, 2026-06-14",
          },
        ],
      },
      {
        name: "Mastercard Foundation",
        location: "Toronto, Canada",
        website: "https://mastercardfdn.org/",
        geography: "Africa and selected global learning priorities",
        focus_areas: ["youth livelihoods", "agriculture", "digital economy", "smallholder farmers"],
        typical_grant_size: 1000000,
        latest_filing_year: 2024,
        guidelineStatus: "New-candidate seed for digital agriculture and livelihoods. Verify current geographic eligibility because many priorities are Africa-centered.",
        invitationStatus: "Often strategy-led and partnership-driven.",
        grantSizeFitNote: "The requested range may fit only if the geography and partner strategy align.",
        peerSignals: ["smallholder farmer livelihood organizations", "digital agriculture platforms", "youth livelihood programs"],
        peerGrantEvidence: [
          {
            recipient: "One Acre Fund",
            amount: "",
            year: 2024,
            purpose: "Co-funded peer signal from the Digital Green benchmark screenshot for smallholder farmer and agricultural livelihood work.",
            source: "User-provided Digital Green benchmark screenshot, 2026-06-14",
          },
        ],
      },
    ],
  },
  {
    id: "global_health_digital_health",
    label: "global health and digital health deterministic fallback",
    triggers: [
      /global health/i,
      /digital health/i,
      /telemedicine|telehealth/i,
      /primary care/i,
      /maternal|birthing|delivery ward|newborn/i,
      /south asia|india|nepal|kyrgyzstan/i,
    ],
    candidates: [
      {
        name: "Bill & Melinda Gates Foundation",
        location: "Seattle, WA",
        website: "https://www.gatesfoundation.org/",
        geography: "Global health, including South Asia and low- and middle-income countries",
        focus_areas: ["global health", "maternal newborn and child health", "primary care", "digital health", "health systems"],
        typical_grant_size: 500000,
        guidelineStatus: "Usually strategy-led or RFP-driven. Verify open opportunities and program officer fit before outreach.",
        invitationStatus: "Often relationship-driven outside formal open calls.",
        grantSizeFitNote: "A $250,000-$500,000 program ask can be plausible as a pilot, implementation, or learning grant, but Gates also makes much larger awards.",
        peerSignals: ["PATH", "Dimagi", "Medic", "Jacaranda Health", "Living Goods"],
      },
      {
        name: "Patrick J. McGovern Foundation",
        location: "Boston, MA",
        website: "https://www.mcgovern.org/",
        geography: "Global and United States, with emphasis on AI and data for social impact",
        focus_areas: ["AI for good", "data science", "digital public goods", "health equity", "responsible technology"],
        typical_grant_size: 350000,
        guidelineStatus: "Verify current inquiry process and whether healthcare delivery tools fit the data and AI portfolio.",
        invitationStatus: "Likely relationship or inquiry-led. Confirm before outreach.",
        grantSizeFitNote: "A $250,000-$500,000 ask is within a plausible program-support range for a technology-for-good funder, subject to current guidelines.",
        peerSignals: ["DataKind", "TechChange", "digital public goods organizations", "responsible AI health initiatives"],
        peerGrantEvidence: [
          {
            recipient: "Noora Health",
            amount: 500000,
            year: 2025,
            purpose: "To enhance AI tools that support caregivers in Global Majority countries.",
            source: "https://www.mcgovern.org/grants/",
          },
          {
            recipient: "Dimagi, Inc.",
            amount: 300000,
            year: 2020,
            purpose: "To support visualization and analytics tools for COVID-19 community-based response.",
            source: "https://www.mcgovern.org/grants/",
          },
        ],
      },
      {
        name: "Grand Challenges Canada",
        location: "Toronto, Canada",
        website: "https://www.grandchallenges.ca/",
        geography: "Low- and middle-income countries, including global health innovation settings",
        focus_areas: ["global health innovation", "transition to scale", "maternal and newborn health", "digital health", "health systems"],
        typical_grant_size: 250000,
        guidelineStatus: "Usually open-call or challenge-driven. Verify current funding opportunities and eligibility for a U.S. nonprofit.",
        invitationStatus: "Open calls vary by program and deadline.",
        grantSizeFitNote: "A $250,000-$500,000 request may fit transition-to-scale or matched innovation funding better than a general operating ask.",
        peerSignals: ["Saving Lives at Birth innovators", "maternal newborn health implementers", "LMIC health innovation grantees"],
      },
      {
        name: "Skoll Foundation",
        location: "Palo Alto, CA",
        website: "https://skoll.org/",
        geography: "Global social entrepreneurship",
        focus_areas: ["social entrepreneurship", "health equity", "systems change", "technology-enabled impact"],
        typical_grant_size: 500000,
        guidelineStatus: "Verify current award and partnership pathways. Often relationship-driven and selective.",
        invitationStatus: "Usually selective and network-driven.",
        grantSizeFitNote: "A $250,000-$500,000 ask may be plausible only if framed around scale, systems change, and proven implementation.",
        peerSignals: ["Last Mile Health", "Living Goods", "Medic", "global health social enterprises"],
        peerGrantEvidence: [
          {
            recipient: "Medic",
            amount: "",
            year: 2014,
            purpose: "Skoll organization record for Medic, formerly Medic Mobile.",
            source: "https://skoll.org/organization/medic/",
          },
          {
            recipient: "Last Mile Health",
            amount: "",
            year: 2017,
            purpose: "Skoll Award peer signal for a comparable global health delivery organization.",
            source: "https://skoll.org/",
          },
        ],
      },
      {
        name: "Mulago Foundation",
        location: "San Francisco, CA",
        website: "https://www.mulagofoundation.org/",
        geography: "Organizations serving people in poverty globally",
        focus_areas: ["poverty", "health", "scalable delivery models", "high-impact organizations"],
        typical_grant_size: 250000,
        guidelineStatus: "Verify fit and nomination or introduction pathway. Mulago is highly selective.",
        invitationStatus: "Relationship-driven. Warm path matters.",
        grantSizeFitNote: "A $250,000-$500,000 ask may fit if framed around measurable scale and cost-effective health outcomes.",
        peerSignals: ["Living Goods", "Last Mile Health", "One Acre Fund-style scale organizations", "community health implementers"],
        peerGrantEvidence: [
          {
            recipient: "Noora Health",
            amount: "",
            year: "",
            purpose: "Mulago Foundation portfolio page for Noora Health.",
            source: "https://www.mulagofoundation.org/portfolio/noora-health",
          },
        ],
      },
      {
        name: "Co-Impact",
        location: "Global",
        website: "https://www.co-impact.org/",
        geography: "Global South and systems-change initiatives",
        focus_areas: ["systems change", "gender equality", "health systems", "education", "economic opportunity"],
        typical_grant_size: 500000,
        guidelineStatus: "Verify current open calls, geography, and whether the work fits systems-change criteria.",
        invitationStatus: "Often program-led and selective.",
        grantSizeFitNote: "A $250,000-$500,000 ask may be small for Co-Impact unless tied to a larger system-change partnership.",
        peerSignals: ["health systems coalitions", "women and girls health initiatives", "Global South systems-change partners"],
      },
      {
        name: "Johnson & Johnson Foundation",
        location: "New Brunswick, NJ",
        website: "https://www.jnj.com/our-societal-impact/johnson-johnson-foundation",
        geography: "Global health workforce and health equity",
        focus_areas: ["frontline health workers", "maternal health", "health equity", "health systems"],
        typical_grant_size: 300000,
        guidelineStatus: "Verify current foundation priorities, invitation status, and country eligibility.",
        invitationStatus: "Often partnership-led.",
        grantSizeFitNote: "A $250,000-$500,000 ask may fit health workforce or maternal health implementation if country priorities align.",
        peerSignals: ["frontline health worker organizations", "maternal health implementers", "health workforce coalitions"],
      },
    ],
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
    "peerOrganizations",
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
  if (isBlank(organizationProfile.peerOrganizations)) {
    assumptions.push("Peer organizations were not supplied. Ask for 3-5 peer organizations or similar grantees to improve funder matching.");
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
    profile.peerOrganizations,
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

function peerOrganizationList(profile) {
  return [
    ...text(profile.peerOrganizations).split(/[;\n,]/),
    ...text(profile.currentFunders).split(/[;\n,]/),
  ]
    .map((item) => item.trim())
    .filter((item) => item.length > 2)
    .slice(0, 8);
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
  if (/washington,\s*dc|washington dc|district of columbia|\bdc\b/.test(raw)) {
    ["washington dc", "washington, dc", "district of columbia"].forEach((term) => expanded.add(term));
  }
  if (/raleigh|durham|cary|wake county|triangle region|\btriangle\b/.test(raw)) {
    ["raleigh", "durham", "cary", "wake county", "triangle"].forEach((term) => {
      if (raw.includes(term)) {
        expanded.add(term);
      }
    });
  }
  if (/south asia|india|nepal|kyrgyzstan|bangladesh|pakistan|sri lanka/.test(raw)) {
    ["south asia", "india", "nepal", "kyrgyzstan"].forEach((term) => {
      if (raw.includes(term)) {
        expanded.add(term);
      }
    });
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

function profileHasInternationalScope(profile) {
  return /\b(?:global|international|south asia|global south|low- and middle-income|low and middle income|lmic|india|nepal|kyrgyzstan|bangladesh|pakistan|sri lanka)\b/i.test(text(profile.geographyServed));
}

function profileHasGlobalHealthScope(profile) {
  return profileHasInternationalScope(profile)
    && /\b(?:global health|digital health|telemedicine|telehealth|primary care|maternal|birthing|delivery ward|newborn|healthcare|hospital|doctor|south asia|india|nepal|kyrgyzstan)\b/i.test([
      profile.mission,
      profile.programsOrFundingNeeds,
      profile.geographyServed,
      profile.beneficiaries,
      profile.evidenceOfResults,
    ].map(text).join(" "));
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

function regionalFallbackCandidates(profile) {
  const geography = text(profile.geographyServed);
  const matches = Object.values(regionalFallbackCatalog).filter((region) => (
    region.aliases.some((pattern) => pattern.test(geography))
  ));
  return matches.flatMap((region) => region.candidates.map((candidate) => normalizeCandidate({
    ...candidate,
    foundation_type: candidate.foundation_type ?? "regional_fallback_seed",
    source_type: "regional_fallback_seed",
    source_label: `${region.label} deterministic regional fallback`,
    openness: "Regional fallback seed. Verify current guidelines, invitation status, and recent grants before outreach.",
  })));
}

function causeFallbackCandidates(profile) {
  const source = [
    profile.organizationName,
    profile.website,
    profile.mission,
    profile.programsOrFundingNeeds,
    profile.geographyServed,
    profile.beneficiaries,
    profile.evidenceOfResults,
    text(profile.peerOrganizations),
  ].map(text).join(" ");
  const matches = causeFallbackCatalog.filter((cause) => cause.triggers.some((pattern) => pattern.test(source)));
  return matches.flatMap((cause) => cause.candidates.map((candidate) => normalizeCandidate({
    ...candidate,
    foundation_type: candidate.foundation_type ?? "cause_fallback_seed",
    source_type: "cause_fallback_seed",
    source_label: cause.label,
    openness: candidate.guidelineStatus,
  })));
}

function addRegionalFallbackCandidates(candidateMap, profile, sourceNotes) {
  const seeds = regionalFallbackCandidates(profile);
  if (seeds.length === 0) {
    return 0;
  }
  let added = 0;
  for (const seed of seeds) {
    const key = text(seed.ein ?? seed.name ?? seed.legal_name ?? seed.foundation_name);
    if (key && !candidateMap.has(key)) {
      candidateMap.set(key, seed);
      added += 1;
    }
  }
  if (added > 0) {
    const regions = [...new Set(seeds.map((seed) => seed.source_label).filter(Boolean))].join("; ");
    sourceNotes.push(`Deterministic regional fallback added ${added} seed candidate(s): ${regions}. Verify all seed prospects before outreach.`);
  }
  return added;
}

function addCauseFallbackCandidates(candidateMap, profile, sourceNotes) {
  const seeds = causeFallbackCandidates(profile);
  if (seeds.length === 0) {
    return 0;
  }
  let added = 0;
  for (const seed of seeds) {
    const key = text(seed.ein ?? seed.name ?? seed.legal_name ?? seed.foundation_name);
    if (key && !candidateMap.has(key)) {
      candidateMap.set(key, seed);
      added += 1;
    }
  }
  if (added > 0) {
    const sources = [...new Set(seeds.map((seed) => seed.source_label).filter(Boolean))].join("; ");
    sourceNotes.push(`Deterministic cause fallback added ${added} seed candidate(s): ${sources}. Verify current guidelines, peer grants, and invitation status before outreach.`);
  }
  return added;
}

function isDeterministicSeed(candidate) {
  return candidate.source_type === "regional_fallback_seed" || candidate.source_type === "cause_fallback_seed";
}

function recentGrants(candidate) {
  return [
    ...(Array.isArray(candidate.recent_grants) ? candidate.recent_grants : []),
    ...(Array.isArray(candidate.peerGrantEvidence) ? candidate.peerGrantEvidence : []),
  ];
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
  const peers = peerOrganizationList(profile).map((peer) => peer.toLowerCase());
  return recentGrants(candidate).filter((grant) => {
    const body = grantText(grant);
    return words.filter((word) => body.includes(word)).length >= 2 || peers.some((peer) => body.includes(peer));
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

function peerGrantMatches(profile, candidate) {
  const peers = peerOrganizationList(profile).map((peer) => peer.toLowerCase());
  if (peers.length === 0) {
    return [];
  }
  return recentGrants(candidate)
    .filter((grant) => {
      const body = grantText(grant);
      return peers.some((peer) => body.includes(peer));
    })
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
  if (profileHasInternationalScope(profile) && /\b(global|globally|global south|low- and middle-income|low and middle income|lmic|worldwide)\b/.test(body)) {
    return { score: 12, status: "international_scope_but_unconfirmed_country_fit", hits: [], grantMatches };
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
  if (isDeterministicSeed(candidate)) {
    return "grantmaker";
  }
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
    sourceType: candidate.source_type ?? "live_or_uploaded",
    similarGrantees: evidence.similarMatches.length,
    peerGrantMatches: evidence.peerMatches.length,
  };
  const hasPeerEvidence = evidence.peerMatches.length > 0
    || (Array.isArray(candidate.peerGrantEvidence) && candidate.peerGrantEvidence.length > 0);
  const liveGlobalHealthNeedsVerification = profileHasGlobalHealthScope(profile)
    && !isDeterministicSeed(candidate)
    && !hasPeerEvidence
    && evidence.geography.status !== "recent_grant_geography_match";

  if (evidence.funderType === "unclear") {
    cautions.push("Grantmaker status is unclear in available data.");
  }
  if (isDeterministicSeed(candidate)) {
    cautions.push("Candidate came from a deterministic fallback and needs current 990, guidelines, recent peer grants, and invitation-status verification.");
  }
  if (evidence.funderType === "partnership_or_intermediary") {
    cautions.push("May be a partnership or intermediary target rather than a direct foundation prospect.");
  }
  if (evidence.program.score < 10) {
    disqualifiers.push("Program fit is weak or not visible in recent grants.");
  }
  if (evidence.geography.score < 8) {
    disqualifiers.push("No clear geography evidence for the user's service area.");
  } else if (liveGlobalHealthNeedsVerification) {
    cautions.push("Live global-health search result lacks peer-grantee or target-country grant evidence.");
  } else if (evidence.geography.status === "international_scope_but_unconfirmed_country_fit" && !hasPeerEvidence) {
    cautions.push("International scope is visible, but target country or peer-grantee fit is not confirmed.");
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
  } else if (isDeterministicSeed(candidate) && evidence.program.score >= 12 && evidence.geography.score >= 10) {
    prospectCategory = "relationship_first_prospect";
  } else if (evidence.grantSize.status === "typical_grant_far_above_range") {
    prospectCategory = evidence.relationship.score >= 8 ? "relationship_first_prospect" : "research_only";
  } else if (evidence.openness.status === "invitation_or_closed") {
    prospectCategory = "relationship_first_prospect";
  } else if (liveGlobalHealthNeedsVerification) {
    prospectCategory = "research_only";
  } else if (!isDeterministicSeed(candidate)
    && evidence.geography.status === "international_scope_but_unconfirmed_country_fit"
    && !hasPeerEvidence) {
    prospectCategory = "research_only";
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
  if (gate.evidenceFlags.sourceType === "regional_fallback_seed" || gate.evidenceFlags.sourceType === "cause_fallback_seed") {
    return "Low";
  }
  const essentials = [
    evidence.program.score >= 17,
    evidence.geography.score >= 17,
    evidence.grantSize.score >= 10,
    evidence.recency.score >= 10,
    evidence.peerMatches.length > 0 || evidence.similarMatches.length > 0,
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
    peerMatches: peerGrantMatches(profile, candidate),
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
  if (isDeterministicSeed(candidate)) {
    parts.push("Deterministic fallback seed based on known funder focus patterns, not verified recent grant evidence.");
  }
  if (candidate.guidelineStatus) {
    parts.push(`Guidelines status: ${candidate.guidelineStatus}`);
  }
  if (candidate.grantSizeFitNote) {
    parts.push(`Grant-size fit note: ${candidate.grantSizeFitNote}`);
  }
  if (evidence.program.grantMatches.length > 0) {
    parts.push(`${evidence.program.grantMatches.length} peer or recent grant signal(s) show program fit.`);
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
  if (isDeterministicSeed(candidate)) {
    return "Seeded prospect. Verify current 990 data, guidelines, recent peer grants, invitation status, and grant-size fit before outreach.";
  }
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

async function callKindoraTool(name, args, mcpUrl = KINDORA_MCP_URL, timeoutMs = KINDORA_TIMEOUT_MS) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
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
  if (options?.causeFallbackOnly) {
    const candidates = causeFallbackCandidates(profile);
    const sources = [...new Set(candidates.map((candidate) => candidate.source_label).filter(Boolean))].join("; ");
    return {
      candidates,
      sourceNotes: candidates.length > 0
        ? [`Deterministic cause fallback only: ${candidates.length} seed candidate(s) for ${sources}. Verify current guidelines, peer grants, and invitation status before outreach.`]
        : ["Deterministic cause fallback only: no matching cause seed candidates found."],
    };
  }

  if (options?.regionalFallbackOnly) {
    const candidates = regionalFallbackCandidates(profile);
    const regions = [...new Set(candidates.map((candidate) => candidate.source_label).filter(Boolean))].join("; ");
    return {
      candidates,
      sourceNotes: candidates.length > 0
        ? [`Deterministic regional fallback only: ${candidates.length} seed candidate(s) for ${regions}. Verify all seed prospects before outreach.`]
        : ["Deterministic regional fallback only: no matching regional seed candidates found."],
    };
  }

  if (USE_MOCK_DATA || options?.mockMode) {
    return { candidates: mockCandidates, sourceNotes: ["Using mock data for deterministic pilot testing."] };
  }

  const queries = buildSearchQueries(profile, options?.secondPassOnly ? "local" : "primary");
  const candidates = new Map();
  const sourceNotes = [];
  const searchResults = await mapWithConcurrency(queries, 4, async (query) => {
    const notes = [];
    let extracted = [];
    try {
      const result = await callKindoraTool("search_funders", {
        query,
        limit: Math.min(Math.max(Number(options?.maxProspects ?? 6), 4), 8),
        exclude_funder_types: ["operating_nonprofit"],
      }, KINDORA_MCP_URL, KINDORA_SEARCH_TIMEOUT_MS);
      extracted = extractCandidates(result);
      notes.push(`${options?.secondPassOnly ? "Second-pass local" : "Primary"} Kindora search_funders query: ${query} (${extracted.length} candidate(s))`);
      if (extracted.length === 0 && KINDORA_MCP_URL !== KINDORA_FALLBACK_MCP_URL) {
        const fallbackResult = await callKindoraTool("search_funders", {
          query,
          limit: Math.min(Math.max(Number(options?.maxProspects ?? 6), 4), 8),
          exclude_funder_types: ["operating_nonprofit"],
        }, KINDORA_FALLBACK_MCP_URL, KINDORA_SEARCH_TIMEOUT_MS);
        extracted = extractCandidates(fallbackResult);
        notes.push(`Fallback Kindora search_funders query: ${query} (${extracted.length} candidate(s))`);
      }
    } catch (error) {
      notes.push(`Kindora search failed for "${query}": ${error instanceof Error ? error.message : String(error)}`);
    }
    return { query, notes, extracted };
  });
  for (const searchResult of searchResults) {
    sourceNotes.push(...searchResult.notes);
    for (const candidate of searchResult.extracted) {
      const key = text(candidate.ein ?? candidate.EIN ?? candidate.name ?? candidate.legal_name);
      if (key && !candidates.has(key)) {
        candidates.set(key, normalizeCandidate(candidate));
      }
    }
  }
  const regionalFallbackCount = options?.disableRegionalFallback
    ? 0
    : addRegionalFallbackCandidates(candidates, profile, sourceNotes);
  const causeFallbackCount = options?.disableCauseFallback
    ? 0
    : addCauseFallbackCandidates(candidates, profile, sourceNotes);
  const fallbackCount = regionalFallbackCount + causeFallbackCount;
  const maxPool = options?.secondPassOnly
    ? clamp(Number(options?.maxProspects ?? 6), 4, 8) + fallbackCount
    : clamp(Number(options?.maxProspects ?? 6) * 2, 6, 12) + fallbackCount;
  const allCandidates = [...candidates.values()];
  const deterministicSeeds = allCandidates.filter(isDeterministicSeed);
  const liveCandidates = allCandidates.filter((candidate) => !isDeterministicSeed(candidate));
  const initial = [
    ...deterministicSeeds,
    ...liveCandidates.slice(0, Math.max(0, maxPool - deterministicSeeds.length)),
  ];
  const detailed = await mapWithConcurrency(initial, 4, (candidate) => enrichCandidate(candidate, profile, sourceNotes));
  return { candidates: detailed, sourceNotes };
}

async function mapWithConcurrency(items, concurrency, mapper) {
  const results = new Array(items.length);
  let cursor = 0;
  async function worker() {
    while (cursor < items.length) {
      const index = cursor;
      cursor += 1;
      results[index] = await mapper(items[index], index);
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, worker));
  return results;
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
  const healthProfile = [
    profile.mission,
    profile.programsOrFundingNeeds,
    profile.geographyServed,
    profile.beneficiaries,
    profile.evidenceOfResults,
  ].map(text).join(" ").toLowerCase();
  const globalHealthHint = /(global health|digital health|telemedicine|telehealth|primary care|maternal|birthing|delivery ward|newborn|south asia|india|nepal|kyrgyzstan|hospital|healthcare)/.test(healthProfile);
  const nonprofitTechHint = /(techsoup|network for good|nonprofit technology|digital capacity|fundraising infrastructure|donor infrastructure|technology access|online giving|digital giving|nonprofit capacity)/.test(healthProfile);
  const digitalAgricultureHint = /(digital green|farmerchat|smallholder|small-scale farmer|digital agriculture|climate-smart agriculture|agricultural advice|farmer livelihoods|extension partners|food systems)/.test(healthProfile);
  const programWords = [...keywordSet(profile)];
  const workforceProfile = [
    profile.mission,
    profile.programsOrFundingNeeds,
    profile.beneficiaries,
    profile.fundingType,
  ].map(text).join(" ").toLowerCase();
  const workforceHint = !globalHealthHint && (
    /\b(workforce|career|jobs?|employment|living-wage|apprenticeship|job placement|career pathways)\b/.test(workforceProfile)
    || (/\bdigital skills?\b/.test(workforceProfile) && /\b(work|career|job|employment|training)\b/.test(workforceProfile))
    || programWords.some((word) => /^(workforce|career|employment|apprenticeship)$/.test(word))
  );
  const beneficiaryHint = text(profile.beneficiaries) || "community";
  const peers = peerOrganizationList(profile);
  const sectorQueries = [];
  if (workforceHint) {
    sectorQueries.push("workforce development", "youth employment", "digital skills training", "career pathways");
  }
  if (globalHealthHint) {
    sectorQueries.push(
      "global health digital health",
      "telemedicine global health",
      "maternal newborn health digital health",
      "primary care South Asia",
      "India telemedicine health systems",
      "digital health foundation grants",
    );
  }
  if (nonprofitTechHint) {
    sectorQueries.push(
      "nonprofit technology foundation grants",
      "digital capacity building funders",
      "online giving infrastructure funders",
      "nonprofit fundraising infrastructure grants",
      "TechSoup funders",
      "Network for Good funders",
    );
  }
  if (digitalAgricultureHint) {
    sectorQueries.push(
      "digital agriculture foundation grants",
      "smallholder farmer funders",
      "climate-smart agriculture philanthropy",
      "agricultural technology foundation grants",
      "Digital Green funders",
      "FarmerChat agriculture funders",
    );
  }
  const primaryQueries = [
    ...sectorQueries,
    ...peers.map((peer) => `${peer} funders`),
    primary,
    `${primary} foundation grants`.trim(),
    `${primary} ${geo}`.trim(),
    secondary,
    `${beneficiaryHint} ${primary}`.trim(),
  ];
  const localQueries = [
    `${localGeo} ${primary} foundation grants`.trim(),
    `${localGeo} ${beneficiaryHint} grants`.trim(),
  ];
  if (workforceHint) {
    localQueries.unshift(
      `${localGeo} workforce training grants young adults`,
      `${localGeo} workforce development`,
      `${localGeo} youth employment`,
      `${localGeo} digital skills`,
      `${localGeo} career pathways philanthropy`,
      `${localGeo} youth employment foundation grants`,
      `${localGeo} digital skills foundation grants`,
      `${localGeo} workforce development foundation grants`,
    );
  }
  if (globalHealthHint) {
    localQueries.unshift(
      `${localGeo} digital health foundation grants`,
      `${localGeo} global health foundation grants`,
      `${localGeo} maternal health foundation grants`,
      `${localGeo} telemedicine foundation grants`,
    );
  }
  if (nonprofitTechHint) {
    localQueries.unshift(
      `${localGeo} nonprofit technology funders`,
      `${localGeo} digital capacity building grants`,
      `${localGeo} fundraising infrastructure funders`,
    );
  }
  if (digitalAgricultureHint) {
    localQueries.unshift(
      `${localGeo} digital agriculture funders`,
      `${localGeo} smallholder farmer grants`,
      `${localGeo} climate-smart agriculture philanthropy`,
    );
  }
  const selected = mode === "local" ? localQueries : primaryQueries;
  return [...new Set(selected.map((query) => query.replace(/\s+/g, " ").trim()).filter(Boolean))].slice(0, mode === "local" ? 8 : 8);
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
      result: await callKindoraTool(toolName, args, KINDORA_MCP_URL, KINDORA_DETAIL_TIMEOUT_MS),
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
  const grants = recentGrants(prospect).slice(0, 2).map(compactGrant);
  return {
    rank,
    foundationName: displayName(prospect),
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
    dueDiligence: {
      guidelineStatus: prospect.guidelineStatus || "Verify current guidelines before outreach",
      invitationStatus: prospect.invitationStatus || prospect.openness || "Verify invitation status before outreach",
      grantSizeFit: prospect.grantSizeFitNote || `Compared against desired grant size: ${text(profile.desiredGrantSize)}`,
      peerSignals: compactList(prospect.peerSignals, 6) || "Ask for peer organizations or verify recent peer grantees",
      peerGrantEvidence: compactList(prospect.peerGrantEvidence, 4) || "No public peer-grant evidence attached",
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

function displayName(prospect) {
  return text(
    prospect.name
      ?? prospect.legal_name
      ?? prospect.foundation_name
      ?? prospect.organization_name
      ?? prospect.propublica_name
      ?? prospect.ein
      ?? "Unnamed funder",
  );
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
    name: displayName(prospect),
    ein: prospect.ein ?? "",
    location: compactValue(prospect.location, 120),
    website: prospect.website ?? "",
    latest_filing_year: prospect.latest_filing_year ?? "",
    total_assets: prospect.total_assets ?? "",
    annual_grants: prospect.annual_grants ?? "",
    typical_grant_size: prospect.typical_grant_size ?? "",
    focus_areas: compactList(prospect.focus_areas, 4),
    geography: compactValue(prospect.geography, 200),
    source_type: prospect.source_type ?? "",
    source_label: prospect.source_label ?? "",
    guidelineStatus: compactValue(prospect.guidelineStatus, 240),
    invitationStatus: compactValue(prospect.invitationStatus, 180),
    grantSizeFitNote: compactValue(prospect.grantSizeFitNote, 220),
    peerSignals: compactList(prospect.peerSignals, 6),
    peerGrantEvidence: Array.isArray(prospect.peerGrantEvidence) ? prospect.peerGrantEvidence.slice(0, 4).map(compactGrant) : [],
    sample_grants: recentGrants(prospect).slice(0, 2).map(compactGrant),
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
    source_links: [
      prospect.website,
      prospect.filing_pdf_url,
      ...(Array.isArray(prospect.peerGrantEvidence) ? prospect.peerGrantEvidence.map((grant) => grant.source).filter(Boolean) : []),
    ].filter(Boolean).join(" "),
  };
}

function nextActionFor(prospect) {
  if (isDeterministicSeed(prospect)) {
    return "Verify current guidelines, recent grants to peer organizations, invitation status, grant-size fit, and a warm introduction path before outreach.";
  }
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
    foundation_name: displayName(prospect),
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
      `- Guidelines status: ${brief.dueDiligence?.guidelineStatus ?? "Verify current guidelines before outreach"}`,
      `- Invitation status: ${brief.dueDiligence?.invitationStatus ?? "Verify invitation status before outreach"}`,
      `- Grant-size fit: ${brief.dueDiligence?.grantSizeFit ?? "Verify grant-size fit before outreach"}`,
      `- Peer signals to verify: ${text(brief.dueDiligence?.peerSignals) || "Ask for peer organizations or verify recent peer grantees"}`,
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
  if (!USE_MOCK_DATA && !options?.mockMode && !options?.regionalFallbackOnly && !options?.causeFallbackOnly && activeCandidates.length < shortlistSize) {
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
  const usesDeterministicFallback = prospects.some((prospect) => isDeterministicSeed(prospect));
  const status = sourceNotes.some((note) => /failed/i.test(note)) || prospects.length < 3 || usesDeterministicFallback ? "partial" : "complete";
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
      `Shortlisted active prospects: ${prospects.length}.`,
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
    const scoreDelta = b.totalFitScore - a.totalFitScore;
    if (scoreDelta !== 0) {
      return scoreDelta;
    }
    return peerEvidenceCount(b) - peerEvidenceCount(a);
  });
}

function peerEvidenceCount(prospect) {
  return Array.isArray(prospect.peerGrantEvidence) ? prospect.peerGrantEvidence.length : 0;
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
  buildSearchQueries,
  buildPipelineRows,
  buildXlsx,
  rowsToCsv,
  openApi,
};
