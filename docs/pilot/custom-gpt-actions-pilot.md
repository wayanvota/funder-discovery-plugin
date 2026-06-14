# Custom GPT Actions Pilot

This pilot is for nontechnical fundraisers. They should not see GitHub, MCP, OpenAPI, JSON, or Developer Mode.

## Architecture

```text
Fundraiser -> Custom GPT -> GPT Action -> Hosted Funder Discovery API -> Kindora / ProPublica
```

The GPT handles the conversation. The action server handles the structured workflow:

- Intake readiness check.
- Foundation discovery.
- Fit scoring.
- Prospect quality gating.
- Deterministic regional fallback seeds for common geographies when live ranking is sparse.
- Short funder briefs.
- Downloadable XLSX, CSV, and Markdown pipeline files.

## Why One Main Action

The seamless user experience depends on hiding tool choreography. The GPT should collect the organization profile and call `runFunderDiscoveryPilot` once. Smaller actions exist for diagnostics and testing, not for the normal fundraiser flow.

## Regional Fallback

The action server includes a deterministic regional fallback catalog for common pilot geographies including New York City, Washington DC, San Francisco Bay Area, Los Angeles, Chicago, Boston, Seattle, Atlanta, Philadelphia, Miami, and Dallas. The fallback is additive by default. It helps demos return local or regional starting points even when live search ranks broad national or out-of-area funders first.

Fallback candidates are not treated as verified 990 evidence. They are labeled `regional_fallback_seed`, returned as low-confidence relationship-first prospects when mission and geography match, and marked `partial` until the user verifies current guidelines, latest filings, recent local grants, and a relationship path. Use `disableRegionalFallback: true` to turn this off, or `regionalFallbackOnly: true` for deterministic demo tests.

## Cause Fallback

The action server also includes a deterministic cause fallback for global health and digital health profiles, including telemedicine, primary care, maternal health, South Asia, India, Nepal, and Kyrgyzstan. This fallback is meant to stabilize demos like Intelehealth where live search can rank broad or irrelevant organizations before the funders a fundraiser would expect to review.

Cause fallback candidates are labeled `cause_fallback_seed`, returned as low-confidence relationship-first prospects, and marked `partial`. The response includes guideline status, invitation status, grant-size fit notes, and peer-signal prompts, but these are starter diligence notes, not verified current grants. Use `disableCauseFallback: true` to turn this off, or `causeFallbackOnly: true` for deterministic demo tests.

## Local Run

Mock mode, deterministic:

```bash
npm run start:actions:mock
```

Live mode:

```bash
npm run start:actions
```

The server exposes:

- `GET /health`
- `GET /openapi.json`
- `POST /api/intake/check`
- `POST /api/funder-discovery/run`
- `POST /api/score`
- `POST /api/pipeline/csv`

## Hosting

Deploy the action server to a public HTTPS host. The Custom GPT action schema should point to:

```text
https://YOUR-HOST/openapi.json
```

For a pilot, keep authentication simple. If the GPT is shared only with testers, no authentication may be acceptable. For broader sharing, add an API key or OAuth before public use.

## Privacy Policy

Public GPTs with actions require a valid privacy policy URL. The policy should say:

- Users provide nonprofit profile details voluntarily.
- The service uses public funder and IRS 990-derived data.
- The service may send search terms and organization profile fields to upstream data services to perform prospect discovery.
- The service does not guarantee grant eligibility or funding.
- Users should not enter confidential donor information or sensitive personal data.

## Deployment Checklist

- Public HTTPS endpoint works.
- `/health` returns `status: ok`.
- `/openapi.json` imports cleanly into the GPT action editor.
- The GPT Preview can call `runFunderDiscoveryPilot`.
- Incomplete profile returns natural intake questions.
- Complete profile returns active prospects, research-only candidates, briefs, pipeline rows, and downloadable files.
- Privacy policy URL is present before public sharing.
- Testers understand that recommendations are leads, not guarantees.
