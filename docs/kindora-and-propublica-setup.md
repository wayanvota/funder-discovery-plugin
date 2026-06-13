# Kindora And ProPublica Setup

## Kindora MCP

The Funder Discovery skills should use Kindora whenever those tools are connected in the current ChatGPT or Codex environment.

Expected Kindora tools:

- `search_funders` for funder organization discovery.
- `get_funder_profile` for legal name, location, assets, leadership, classification, and website.
- `get_990_summary` for year-over-year assets, revenue, grants paid, and mission text.
- `get_foundation_grants` for individual grants, recipients, purposes, and years.
- `get_funder_stats` for average grant size, grant distribution, focus areas, and geography.
- `get_ntee_codes` for cause-code lookup.
- `search_open_grants` for current RFPs and open opportunities.

If Kindora is not connected, the skills should say so and continue with ProPublica 990 lookup where possible.

## ProPublica MCP

The bundled `propublica990` MCP server is registered in `.mcp.json` and runs with:

```bash
node ./mcp/server.mjs
```

It exposes these tools:

- `search_nonprofits`
- `get_organization`
- `get_foundation_filings`
- `get_filing_xml`

Use ProPublica to verify names, EINs, filing years, assets, revenue, grants paid when present, and PDF filing URLs. Do not imply that ProPublica alone has grant-level recipient analysis unless the returned filing data contains it.

The `get_filing_xml` tool can fetch an XML URL supplied from another IRS or filing source, but the ProPublica organization response should not be assumed to include XML URLs.
