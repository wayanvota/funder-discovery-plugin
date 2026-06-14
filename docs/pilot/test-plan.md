# Pilot Test Plan

Use this plan to test language, intake questions, scoring, CSV fields, and failure cases before inviting real fundraiser users.

## Test Pass Rules

A run passes only if:

- The GPT asks for missing organization details in plain English.
- The GPT does not expose JSON, OpenAPI, MCP, or backend language to the fundraiser.
- The GPT calls the action only after it has the required intake fields.
- The final answer includes a ranked shortlist, brief per funder, next action per funder, and CSV.
- Weak evidence is labeled as weak.
- The user can understand what to do next without technical knowledge.

## Test Matrix

### 1. Intake Language

Prompt:

```text
I need funders for my nonprofit.
```

Expected:

- GPT asks for mission, funding need, geography, beneficiaries, grant size, and funding type.
- GPT does not ask for EIN first.
- GPT does not mention Actions or API.

### 2. Partial Intake

Prompt:

```text
We run after-school STEM programs for middle school girls in Detroit. Need program funding.
```

Expected:

- GPT asks only for missing grant size and any useful results or relationship context.
- GPT does not restart the full intake.

### 3. Complete Intake

Prompt:

```text
Build a foundation prospect pipeline for a nonprofit that helps low-income young adults in New York City get living-wage jobs through digital skills training and mentoring. We need program support, ideally $50,000 to $150,000. Our last cohort had 78 percent job placement within six months. We have a board member connected to workforce funders.
```

Expected:

- GPT calls `runFunderDiscoveryPilot`.
- Final answer includes a table, briefs, CSV, and verification note.
- It explains that scores are prioritization aids.

### 4. Scoring Sanity

Use a profile with geography in New York and desired grant size $50,000 to $150,000.

Expected:

- Funders with aligned mission language and plausible grant size outrank stale or off-topic funders.
- A famous or large foundation should not outrank better-fit foundations solely because it has more assets.

### 5. CSV Fields

Expected CSV columns:

```text
rank,foundation_name,ein,website,hq_location,latest_filing_year,assets,annual_grants_paid,typical_grant_size,program_fit_score,geography_fit_score,grant_size_fit_score,recency_score,openness_score,relationship_path_score,total_fit_score,confidence,stage,recommended_ask,next_action,owner,deadline,relationship_path,evidence_summary,main_risk,source_links
```

Fail if:

- `next_action` is blank.
- `confidence` is blank.
- `main_risk` is blank.
- The CSV is not importable because of unescaped commas or line breaks.

### 6. Failure Case: Vague Mission

Prompt:

```text
We help people and need grants anywhere in the United States.
```

Expected:

- GPT refuses to produce a fake strong pipeline.
- GPT asks for specific program, beneficiary, geography, and grant size.

### 7. Failure Case: Unrealistic Ask

Prompt:

```text
We are a $300,000 nonprofit seeking $5 million from family foundations for a new national campaign.
```

Expected:

- GPT flags grant-size mismatch.
- GPT suggests narrowing the ask or seeking different funder types.
- It does not score small family foundations as strong prospects unless evidence supports unusually large grants.

### 8. Failure Case: No Relationship Path

Expected:

- Relationship path score is conservative.
- Next actions include relationship mapping or peer-grantee introduction.

### 9. Stale Data

Expected:

- If latest filing year is old, GPT names the stale year.
- GPT tells the user to verify current guidelines before outreach.

## Tester Feedback Questions

Ask each tester:

- Did the first question feel easy to answer?
- Which intake question was confusing?
- Did the ranked list feel credible?
- Did any funder feel obviously wrong?
- Was the score explanation clear enough to defend to your executive director?
- Would you import the CSV into your CRM?
- What next action would you actually take tomorrow?
