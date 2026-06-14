process.env.FUNDER_DISCOVERY_MOCK = "1";

const {
  buildPipelineRows,
  checkProfile,
  runDiscovery,
  scoreProspect,
} = await import("../actions/action-server.mjs");

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

function includesAny(value, patterns) {
  const source = JSON.stringify(value).toLowerCase();
  return patterns.some((pattern) => new RegExp(`\\b${pattern}\\b`, "i").test(source));
}

function profileBase(overrides = {}) {
  return {
    organizationName: "Youth Pathways",
    mission: "Help low-income young adults build career pathways into living-wage work.",
    programsOrFundingNeeds: "Youth workforce training, mentoring, and digital skills program expansion.",
    geographyServed: "New York City",
    beneficiaries: "Low-income young adults ages 18 to 24",
    desiredGrantSize: { min: 50000, max: 150000 },
    fundingType: "Program support",
    evidenceOfResults: "78 percent job placement within six months for recent cohorts.",
    relationshipAssets: ["board member connected to workforce funders"],
    ownerNames: ["Development Director"],
    ...overrides,
  };
}

const sparse = checkProfile({});
assert(!sparse.ready, "Sparse profile should not be ready.");
assert(sparse.questions.length >= 6, "Sparse profile should ask all six core intake questions.");
assert(!includesAny(sparse.questions, ["ein", "api", "json", "openapi", "mcp"]), "Intake questions should not use technical or EIN-first language.");

const partial = checkProfile({
  mission: "Run after-school STEM programs.",
  programsOrFundingNeeds: "After-school STEM program funding.",
  geographyServed: "Detroit",
  beneficiaries: "Middle school girls",
  fundingType: "Program funding",
});
assert(!partial.ready, "Partial profile without grant size should not be ready.");
assert(partial.missingFields.length === 1 && partial.missingFields[0] === "desiredGrantSize", "Partial intake should ask only for missing grant size.");

const complete = await runDiscovery({
  organizationProfile: profileBase(),
  options: { shortlistSize: 5, mockMode: true },
});
assert(["complete", "partial"].includes(complete.status), "Complete profile should return a discovery result.");
assert(complete.prospects.length >= 3, "Complete profile should return an active shortlist.");
assert(complete.prospects.every((prospect) => ["direct_grant_prospect", "relationship_first_prospect"].includes(prospect.prospectCategory)), "Active shortlist should include only active prospect categories.");
assert(Array.isArray(complete.researchOnlyProspects), "Discovery should return research-only candidates.");
assert(complete.downloadLinks?.xlsx && complete.downloadLinks?.csv && complete.downloadLinks?.markdown, "Discovery should return XLSX, CSV, and Markdown links.");
assert(!("csv" in complete) && !("markdown" in complete), "Discovery should not paste raw CSV or Markdown bodies.");

const nycFallback = await runDiscovery({
  organizationProfile: profileBase(),
  options: { shortlistSize: 5, regionalFallbackOnly: true },
});
assert(nycFallback.status === "partial", "Regional fallback-only results should be marked partial until verified against live filings.");
assert(nycFallback.prospects.length >= 3, "NYC regional fallback should create a usable local demo shortlist.");
assert(nycFallback.prospects.every((prospect) => prospect.source_type === "regional_fallback_seed"), "NYC fallback prospects should be labeled as regional fallback seeds.");
assert(nycFallback.prospects.every((prospect) => prospect.confidence === "Low"), "Regional fallback prospects should stay low confidence until verified.");
assert(nycFallback.prospects.some((prospect) => /New York|Robin Hood|Pinkerton|Altman|Tiger/i.test(prospect.name)), "NYC fallback should include recognizable regional funders.");
assert(nycFallback.sourceNotes.some((note) => /Deterministic regional fallback/i.test(note)), "NYC fallback should disclose deterministic seed source.");
assert(!nycFallback.sourceNotes.some((note) => /Second-pass local search/i.test(note)), "Regional fallback-only mode should not trigger second-pass live search notes.");
assert(nycFallback.prospects.every((prospect) => /verify/i.test(`${prospect.nextAction} ${prospect.mainRisk}`)), "Regional fallback prospects should require verification before outreach.");

const sfFallback = await runDiscovery({
  organizationProfile: profileBase({
    geographyServed: "San Francisco Bay Area",
    programsOrFundingNeeds: "Digital skills, youth employment, and economic mobility program support.",
  }),
  options: { shortlistSize: 3, regionalFallbackOnly: true },
});
assert(sfFallback.prospects.length >= 3, "SF regional fallback should create a usable local demo shortlist.");
assert(sfFallback.prospects.some((prospect) => /San Francisco Foundation|Tipping Point|Haas/i.test(prospect.name)), "SF fallback should include recognizable Bay Area funders.");
assert(sfFallback.prospects.every((prospect) => /San Francisco|Bay Area/i.test(`${prospect.location} ${prospect.geography} ${prospect.source_label}`)), "SF fallback prospects should carry local geography labels.");

const expectedCsvColumns = [
  "rank",
  "foundation_name",
  "ein",
  "website",
  "hq_location",
  "latest_filing_year",
  "assets",
  "annual_grants_paid",
  "typical_grant_size",
  "program_fit_score",
  "geography_fit_score",
  "grant_size_fit_score",
  "recency_score",
  "openness_score",
  "relationship_path_score",
  "total_fit_score",
  "prospect_category",
  "confidence",
  "stage",
  "recommended_ask",
  "next_action",
  "owner",
  "deadline",
  "relationship_path",
  "evidence_summary",
  "main_risk",
  "why_not",
  "similar_grantee_matches",
  "source_links",
];
const actualCsvColumns = Object.keys(complete.pipelineRows[0] ?? {});
assert(JSON.stringify(actualCsvColumns) === JSON.stringify(expectedCsvColumns), "CSV columns do not match the pilot test plan.");
for (const row of complete.pipelineRows) {
  assert(row.next_action, "Pipeline row missing next_action.");
  assert(row.confidence, "Pipeline row missing confidence.");
  assert(row.main_risk, "Pipeline row missing main_risk.");
  assert(row.prospect_category, "Pipeline row missing prospect_category.");
  assert(row.why_not, "Pipeline row missing why_not.");
}

const aligned = scoreProspect(profileBase(), {
  name: "Aligned NYC Workforce Fund",
  foundation_type: "independent_foundation",
  latest_filing_year: 2024,
  typical_grant_size: 90000,
  geography: "New York City",
  recent_grants: [
    { recipient: "NYC Youth Jobs", amount: 85000, year: 2024, purpose: "Digital skills and youth workforce training in New York City" },
  ],
  openness: "LOI accepted",
});
const famousWeak = scoreProspect(profileBase(), {
  name: "Famous Mega Foundation",
  foundation_type: "private foundation",
  total_assets: 10000000000,
  latest_filing_year: 2024,
  typical_grant_size: 2500000,
  geography: "National",
  recent_grants: [
    { recipient: "Museum Capital Campaign", amount: 2500000, year: 2024, purpose: "Building expansion" },
  ],
  openness: "Invitation only",
});
assert(aligned.totalFitScore > famousWeak.totalFitScore, "Aligned funder should outrank famous weak-fit funder.");
assert(["research_only", "relationship_first_prospect", "reject"].includes(famousWeak.prospectCategory), "Famous weak-fit funder should not be a direct active prospect.");

const vague = await runDiscovery({
  organizationProfile: {
    mission: "We help people.",
    programsOrFundingNeeds: "Grants.",
    geographyServed: "Anywhere in the United States",
    beneficiaries: "People",
    desiredGrantSize: "Any amount",
    fundingType: "General support",
  },
  options: { mockMode: true },
});
assert(vague.status === "needs_more_info", "Vague mission should ask for more detail instead of producing a fake pipeline.");

const unrealisticProfile = profileBase({
  annualBudget: "$300,000",
  desiredGrantSize: { min: 5000000, max: 5000000 },
});
const smallFamily = scoreProspect(unrealisticProfile, {
  name: "Small Family Foundation",
  foundation_type: "family_foundation",
  latest_filing_year: 2024,
  typical_grant_size: 25000,
  geography: "New York City",
  recent_grants: [
    { recipient: "NYC Youth Jobs", amount: 25000, year: 2024, purpose: "Youth employment" },
  ],
  openness: "Invitation only",
});
assert(!["direct_grant_prospect", "relationship_first_prospect"].includes(smallFamily.prospectCategory), "Small family foundation should not be strong for unrealistic $5M ask.");
assert(/grant-size|outside|below|range/i.test(smallFamily.whyNot), "Unrealistic ask should flag grant-size mismatch.");

const noRelationship = scoreProspect(profileBase({ relationshipAssets: [] }), {
  name: "Aligned Open Workforce Fund",
  foundation_type: "independent_foundation",
  latest_filing_year: 2024,
  typical_grant_size: 90000,
  geography: "New York City",
  recent_grants: [
    { recipient: "NYC Youth Jobs", amount: 85000, year: 2024, purpose: "Digital skills and youth workforce training in New York City" },
  ],
  openness: "Invitation only",
});
const noRelationshipRow = buildPipelineRows(profileBase({ relationshipAssets: [] }), [{ ...noRelationship, name: "Aligned Open Workforce Fund" }])[0];
assert(noRelationship.relationshipPathScore <= 3, "No relationship path should score conservatively.");
assert(/map|relationship|peer-grantee|introduction/i.test(noRelationshipRow.next_action), "No relationship path should trigger relationship mapping.");

const stale = scoreProspect(profileBase(), {
  name: "Stale Workforce Fund",
  foundation_type: "independent_foundation",
  latest_filing_year: 2019,
  typical_grant_size: 90000,
  geography: "New York City",
  recent_grants: [
    { recipient: "NYC Youth Jobs", amount: 85000, year: 2019, purpose: "Digital skills and youth workforce training in New York City" },
  ],
  openness: "LOI accepted",
});
assert(stale.recencyScore <= 5, "Stale filing year should receive low recency score.");
assert(/2019|stale|filing|verify/i.test(`${stale.rationale} ${stale.whyNot} ${stale.mainRisk}`), "Stale data should be visible in rationale, risk, or why-not.");

const geographyEcho = scoreProspect(profileBase({
  geographyServed: "New York City with national replication partners",
}), {
  name: "Spokane Workforce Council",
  foundation_type: "grantmaker_evidence",
  location: "Spokane, WA",
  latest_filing_year: 2024,
  typical_grant_size: 90000,
  search_context: "New York City with national replication partners",
  raw_excerpt: "query: New York City workforce development grants",
  recent_grants: [
    { recipient: "Career Path Services", amount: 85000, year: 2024, purpose: "Employment and training", city: "Spokane", state: "WA" },
  ],
  openness: "LOI accepted",
});
assert(geographyEcho.geographyFitScore < 8, "Search/profile context must not count as local geography evidence.");
assert(geographyEcho.prospectCategory === "reject", "Out-of-area regional funder should not pass the active quality gate for NYC.");

const buffaloForNyc = scoreProspect(profileBase(), {
  name: "Buffalo Workforce Fund",
  foundation_type: "private foundation",
  location: "Buffalo, NY",
  latest_filing_year: 2024,
  typical_grant_size: 90000,
  geography: "Western New York",
  recent_grants: [
    { recipient: "Buffalo Career Center", amount: 85000, year: 2024, purpose: "Youth workforce training", city: "Buffalo", state: "NY" },
  ],
  openness: "LOI accepted",
});
assert(buffaloForNyc.geographyFitScore < 8, "New York State evidence should not satisfy a New York City profile.");
assert(buffaloForNyc.prospectCategory === "reject", "Regional New York funder outside NYC should require manual research first.");

const unnamedPipelineRow = buildPipelineRows(profileBase(), [{
  foundation_name: "Fallback Name Foundation",
  totalFitScore: 44,
  prospectCategory: "reject",
  confidence: "Low",
  programFitScore: 12,
  geographyFitScore: 3,
  grantSizeFitScore: 10,
  recencyScore: 10,
  opennessScore: 6,
  relationshipPathScore: 2,
  evidenceFlags: {},
  whyNot: "No clear geography evidence.",
  mainRisk: "No clear geography evidence.",
}])[0];
assert(unnamedPipelineRow.foundation_name === "Fallback Name Foundation", "Pipeline rows should use fallback funder names when normalized name is missing.");

console.log("Pilot test plan passed.");
