process.env.FUNDER_DISCOVERY_MOCK = "1";

const { buildXlsx, openApi, runDiscovery } = await import("../actions/action-server.mjs");

const requiredOperations = [
  "checkOrganizationProfile",
  "runFunderDiscoveryPilot",
  "scoreFoundationProspects",
  "buildPipelineCsv",
];
const operations = Object.values(openApi.paths)
  .flatMap((pathItem) => Object.values(pathItem))
  .map((operation) => operation.operationId)
  .filter(Boolean);
const missing = requiredOperations.filter((operation) => !operations.includes(operation));
if (missing.length > 0) {
  throw new Error(`OpenAPI missing operations: ${missing.join(", ")}`);
}

const incomplete = await runDiscovery({
  organizationProfile: { organizationName: "Sparse Nonprofit" },
});
if (incomplete.status !== "needs_more_info" || incomplete.questions.length === 0) {
  throw new Error("Incomplete profile did not return intake questions.");
}

const complete = await runDiscovery({
  organizationProfile: {
    organizationName: "Youth Pathways",
    mission: "Help low-income young adults build career pathways into living-wage work.",
    programsOrFundingNeeds: "Youth workforce training, mentoring, and digital skills program expansion.",
    geographyServed: "New York City and national replication partners",
    beneficiaries: "Low-income young adults ages 18 to 24",
    desiredGrantSize: "$50,000 to $150,000",
    fundingType: "Program support",
    evidenceOfResults: "78 percent job placement within six months for recent cohorts.",
    relationshipAssets: ["board member connected to workforce funders", "peer grantees in youth employment"],
    ownerNames: ["Development Director"],
  },
  options: { shortlistSize: 5, mockMode: true },
});

if (!["complete", "partial"].includes(complete.status)) {
  throw new Error(`Expected complete or partial discovery, got ${complete.status}`);
}
if (!Array.isArray(complete.prospects) || complete.prospects.length < 3) {
  throw new Error("Discovery did not return enough prospects.");
}
if (!complete.downloadLinks?.csv || !complete.downloadLinks?.markdown || !complete.downloadLinks?.xlsx) {
  throw new Error("Discovery did not return CSV, Markdown, and XLSX download links.");
}
if (!complete.downloadLinksMarkdown?.includes("Download XLSX") || !complete.downloadLinksMarkdown?.includes("Download CSV")) {
  throw new Error("Discovery did not return a user-facing download link block.");
}
if ("csv" in complete || "markdown" in complete) {
  throw new Error("Discovery should return downloadable file links, not raw CSV or Markdown bodies.");
}
const workbook = buildXlsx(complete.pipelineRows);
if (workbook.subarray(0, 2).toString("utf8") !== "PK") {
  throw new Error("Generated XLSX does not have a ZIP file signature.");
}

console.log("Actions check passed.");
