---
name: pipeline-builder
description: Convert funder research and fit scores into a CSV or CRM-ready foundation pipeline with owners, deadlines, next actions, and confidence scores.
---

# Pipeline Builder

Use this skill when the user asks to create a pipeline, export prospects, make a CSV, prepare CRM import rows, assign next actions, or turn funder research into work.

## Inputs

Use:

- The `Funder Discovery Profile`.
- Prospect Discovery results.
- Brief Generator outputs when available.
- Fit Scoring results when available.
- User-provided owner names, deadlines, stage names, and CRM fields.

If owner names are missing, use `Unassigned`. If deadlines are missing, set reasonable review dates based on priority and state that they are defaults.

## Pipeline Stages

Default stages:

- Research
- Qualify
- Relationship Mapping
- Outreach Prep
- LOI Or Inquiry
- Proposal Invited
- Submitted
- Stewardship
- Parked
- Do Not Pursue

Use the user's CRM stage names if provided.

## Next Action Logic

Assign one concrete next action per prospect:

- Verify application process.
- Map board or staff relationship.
- Review latest 990-PF PDF.
- Find program officer or grants contact.
- Check recent grantees for peer introductions.
- Draft LOI concept.
- Park until new filing or RFP.
- Exclude due to poor fit.

Do not leave next action blank.

## Default Deadline Logic

When the user has not supplied deadlines:

- Top prospects with high confidence: 14 days from today.
- Medium confidence prospects: 30 days from today.
- Low confidence prospects needing more research: 45 days from today.
- Parked prospects: 90 days from today.

Use ISO dates in exports.

## CSV Columns

Default CRM-ready columns:

- `rank`
- `foundation_name`
- `ein`
- `website`
- `hq_city`
- `hq_state`
- `latest_filing_year`
- `assets`
- `annual_grants_paid`
- `typical_grant_size`
- `program_fit_score`
- `geography_fit_score`
- `grant_size_fit_score`
- `recency_score`
- `openness_score`
- `relationship_path_score`
- `total_fit_score`
- `confidence`
- `stage`
- `recommended_ask`
- `next_action`
- `owner`
- `deadline`
- `relationship_path`
- `evidence_summary`
- `main_risk`
- `source_links`

Add or rename columns if the user specifies a CRM format.

## Output Format

Return:

1. A short pipeline summary naming the number of prospects, top priority group, and exclusions.
2. A CSV block ready to save or import.
3. A short `Operating Notes` section explaining owner defaults, deadline defaults, and confidence limits.

When working in Codex and the user asks for a file, write the CSV to the workspace with a clear filename such as `funder-pipeline.csv`.

## Quality Bar

A pipeline is only useful if it creates action. If a prospect cannot be assigned a next step, put it in `Parked` or `Do Not Pursue` and explain why.
