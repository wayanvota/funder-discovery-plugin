---
name: brief-generator
description: Generate a one-page foundation brief from public 990 data, Kindora funder data, and the user's Funder Discovery Profile.
---

# Brief Generator

Use this skill when the user asks for a funder brief, foundation brief, one-pager, prospect memo, or summary of a specific foundation.

## Inputs

Required:

- Foundation name or EIN.
- The user's `Funder Discovery Profile`, if fit signals are requested.

If the user gives only a foundation name, search for the EIN first and confirm likely identity when multiple foundations share similar names.

## Data Collection

Prefer Kindora when available:

- `get_funder_profile` for identity, location, assets, leadership, classification, website, and foundation type.
- `get_990_summary` for recent filing years, assets, revenue, grants paid, and trends.
- `get_funder_stats` for average grant size, focus areas, geographic distribution, and year-by-year giving.
- `get_foundation_grants` for recent grants, top grantees, recipient locations, and grant purposes.

Use `propublica990` to verify:

- EIN.
- Organization record.
- Filing years.
- PDF filing links.
- Public filing fields present in ProPublica records.

## Brief Format

Write a one-page brief with these sections:

1. `Foundation Snapshot`
   - Legal name
   - EIN
   - Location
   - Foundation type
   - Website
   - Latest filing year reviewed

2. `Financial Capacity`
   - Assets
   - Grants paid
   - Revenue
   - Giving trend
   - Typical grant size

3. `Giving Pattern`
   - Main program areas
   - Geographic pattern
   - Top or recent grantees
   - Notable grant purposes

4. `People And Access`
   - Board or leadership names found in filings or profile data
   - Staff or contact signals if public
   - Relationship path from the user's profile

5. `Fit Against Our Organization`
   - Program fit
   - Geography fit
   - Grant size fit
   - Timing or recency
   - Openness
   - Risks

6. `Recommended Move`
   - One next action
   - Suggested ask range
   - Confidence level

## Evidence Discipline

Name the filing year used. Mark missing fields as `Not found in available data` instead of guessing.

Do not infer board influence, invitation-only status, or relationship access unless there is evidence. If the available evidence is thin, make the brief useful by saying what must be checked next.
