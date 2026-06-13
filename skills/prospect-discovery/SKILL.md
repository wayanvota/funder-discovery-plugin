---
name: prospect-discovery
description: Find aligned foundation prospects using a nonprofit profile, Kindora philanthropy data, and ProPublica 990 records.
---

# Prospect Discovery

Use this skill when the user wants foundation prospects, funder discovery, aligned funders, open opportunities, or a first ranked list.

## Inputs

Start from the `Funder Discovery Profile`. If it is missing, run or request Organization Details first.

Required profile fields for a credible search:

- Mission or program keywords.
- Geography served.
- Desired grant size.
- Funding type.
- Beneficiaries or cause area.

## Data Source Order

Prefer Kindora tools when available:

1. Use `get_ntee_codes` to map the mission and programs to likely NTEE categories.
2. Use `search_funders` for foundation organizations aligned by cause, funder type, headquarters, grantee country, NTEE, and asset range.
3. Use `get_funder_profile` for each serious candidate.
4. Use `get_990_summary`, `get_funder_stats`, and `get_foundation_grants` to check giving history, average grant size, recent giving, recipient geography, and top focus areas.
5. Use `search_open_grants` only for active RFPs or open opportunities. Do not treat open grants as the full funder universe.

Use the bundled `propublica990` MCP tools when Kindora is missing or when you need to verify a name, EIN, or filing URL:

- `search_nonprofits`
- `get_organization`
- `get_foundation_filings`
- `get_filing_xml`

## Search Strategy

Run multiple narrow searches instead of one broad search:

- Mission terms.
- Beneficiary terms.
- Geography terms.
- NTEE category.
- Similar grantee or peer organization names when provided.
- Grant size range and asset bands.

Exclude obvious false positives:

- Operating nonprofits that look large but are not grantmakers.
- Foundations whose average grant size is far outside the user's realistic ask.
- Foundations with stale or missing grantmaking evidence unless there is a strong relationship path.
- Funders that clearly do not support the user's geography or beneficiary group.

## Output Format

Return a ranked prospect table with:

- Rank
- Foundation
- EIN
- Location
- Latest filing year used
- Assets
- Annual grants paid
- Average or typical grant size
- Evidence of program fit
- Evidence of geography fit
- Similar grants or top grantees
- Openness signal
- Relationship path
- Main risk
- Recommended next step
- Confidence: High, Medium, or Low

After the table, add a short `Discovery Notes` section:

- Searches run.
- Data sources used.
- Important gaps.
- Candidates deliberately excluded and why.

## Quality Bar

Do not call a foundation a strong prospect because it is large or famous. A strong prospect has aligned giving history, plausible grant size, relevant geography, recent activity, and a reachable path.
