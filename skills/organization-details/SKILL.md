---
name: organization-details
description: Collect the nonprofit organization profile and fundraising-fit criteria needed before foundation prospect discovery, brief generation, fit scoring, or pipeline creation.
---

# Organization Details

Use this skill when the user wants to start funder discovery, build a prospect list, score foundations, or create a pipeline and has not already provided a usable nonprofit profile.

## Objective

Build a reusable `Funder Discovery Profile` that captures the nonprofit facts and fit criteria needed to search, brief, score, and prioritize foundations.

## Intake Rules

Ask only for information that is missing and material. Do not ask for everything if the user already supplied enough context to begin.

If the user wants to move quickly, collect the minimum viable profile:

- Legal name and website.
- EIN if known.
- Mission in one sentence.
- Core programs or funding needs.
- Primary geography served.
- Beneficiaries or population served.
- Annual operating budget or approximate budget band.
- Desired grant size range.
- Funding type needed: general operating, program, capital, research, advocacy, regranting, or other.
- Existing major institutional funders, if any.
- Relationship assets: board, staff, advisors, alumni, partners, or known foundation contacts.

For a stronger search, also collect:

- Evidence of results: outcomes, scale, independent evaluation, audited financials, or public reports.
- Program keywords and NTEE-style cause areas.
- Exclusions: funders to avoid, geographies outside scope, religious or political constraints, and ethical red lines.
- Deadline pressure and fundraising goal.
- CRM fields the user wants in the final pipeline.
- Owner names and action capacity.

## Output Format

Return a concise `Funder Discovery Profile` with these fields:

- Organization
- EIN
- Website
- Mission
- Programs or funding needs
- Geography served
- Beneficiaries
- Budget band
- Desired grant size
- Funding type
- Evidence of results
- Current funders
- Relationship assets
- Search keywords
- Likely NTEE areas
- Exclusions
- Deadline or campaign context
- Open questions

Then state whether the profile is ready for Prospect Discovery. If important information is missing, name the gap and explain how it affects prospect quality.

## Quality Bar

Do not inflate thin information into a polished strategy. If the profile is too vague, say so and ask for the smallest set of details needed to make foundation search defensible.
