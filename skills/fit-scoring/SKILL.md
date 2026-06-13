---
name: fit-scoring
description: Score foundation prospects with a transparent 100-point rubric covering program fit, geography, grant size, recency, openness, and relationship path.
---

# Fit Scoring

Use this skill when the user asks to rank, score, compare, prioritize, qualify, or triage foundation prospects.

## Inputs

Use:

- The `Funder Discovery Profile`.
- Candidate foundation records.
- Kindora profile, grants, stats, and 990 summary data when available.
- ProPublica organization and filing records when needed.

If the available data is incomplete, score conservatively and lower the confidence rating.

## Rubric

Score each foundation out of 100:

- Program fit: 25 points
- Geography fit: 20 points
- Average grant size fit: 15 points
- Recency of relevant giving: 15 points
- Openness: 15 points
- Relationship path: 10 points

### Program Fit, 25

- 21-25: Multiple recent grants or stated priorities match the user's mission and program.
- 14-20: Clear adjacent fit, but not a direct match.
- 7-13: Broad category overlap only.
- 0-6: Little or no evidence of program alignment.

### Geography Fit, 20

- 17-20: Recent grants clearly support the user's geography or nationally available work.
- 11-16: Some evidence of geography fit or flexible national giving.
- 5-10: Headquarters or stated interest is plausible, but grantee evidence is weak.
- 0-4: Geography appears out of scope.

### Average Grant Size Fit, 15

- 13-15: Typical grant size fits the user's desired range.
- 8-12: Slightly above or below range but still plausible.
- 4-7: Material mismatch requiring ask adjustment.
- 0-3: Ask is unrealistic relative to giving pattern.

### Recency, 15

- 13-15: Relevant grants in the latest available filing year.
- 8-12: Relevant grants within the last three filing years.
- 4-7: Relevant grants are old or filing data is stale.
- 0-3: No recent evidence.

### Openness, 15

- 13-15: Public application, RFP, LOI, open program, or repeated grants to new organizations.
- 8-12: Some signs of accessible process or staff pathway.
- 4-7: Mostly relationship-based, but not impossible.
- 0-3: Appears closed, family-directed, or inaccessible.

### Relationship Path, 10

- 9-10: Named warm path through board, staff, peer grantee, partner, or funder contact.
- 6-8: Plausible second-degree path.
- 3-5: Cold path with identifiable staff or program lead.
- 0-2: No credible path.

## Confidence Rating

Assign confidence separately from score:

- High: multiple recent data points, grant-level evidence, and clear fit.
- Medium: enough evidence to prioritize, but one or two meaningful gaps.
- Low: thin, stale, contradictory, or inference-heavy evidence.

## Output Format

Return:

- A scored table with component scores.
- A one-sentence rationale for each foundation.
- A `Why This Rank Could Be Wrong` note for the top prospects.
- A list of missing evidence that would most change the ranking.

## Quality Bar

The score must be explainable to a skeptical development director. Do not hide weak evidence behind a precise-looking number.
