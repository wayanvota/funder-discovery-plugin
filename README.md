# Funder Discovery Plugin

Funder Discovery is a Codex plugin for nonprofit fundraisers who need a ranked foundation pipeline, not a pile of unqualified names.

The plugin combines five fundraising skills with public 990 data workflows:

1. Organization Details: collect the nonprofit profile and fit criteria used for prospecting.
2. Prospect Discovery: find aligned foundations by mission, geography, grant size, and giving history.
3. Brief Generator: turn a foundation filing into a one-page funder brief.
4. Fit Scoring: apply a transparent scoring rubric.
5. Pipeline Builder: export a CSV or CRM-ready prospect pipeline with next actions.

## Data Sources

The skills are designed to use Kindora MCP tools when they are available in ChatGPT or Codex. Kindora provides funder search, profiles, 990 summaries, grant lists, giving statistics, NTEE lookup, open grants, and philanthropy jobs.

This repository also includes a local `propublica990` MCP server that queries ProPublica Nonprofit Explorer public endpoints for nonprofit search, organization details, filing summaries, and PDF filing links.

The important discipline is that the plugin does not treat a foundation name as a prospect by itself. It pushes the model to check fit signals, recent giving, grant size, geography, openness, and relationship path before recommending action.

## Repository Layout

```text
.codex-plugin/plugin.json      Plugin manifest
.mcp.json                      Local MCP server registration
mcp/server.mjs                 ProPublica 990 MCP server
skills/organization-details    Nonprofit profile intake skill
skills/prospect-discovery      Foundation discovery workflow
skills/brief-generator         One-page funder brief workflow
skills/fit-scoring             Transparent scoring rubric
skills/pipeline-builder        CSV and CRM pipeline workflow
docs/                          Setup and workflow notes
```

## Install From GitHub

Publish this folder as a public GitHub repository. In a Codex or ChatGPT environment that supports GitHub plugin installs, add the repository as a plugin source.

For best results, also connect the Kindora MCP in the same ChatGPT or Codex environment. The bundled ProPublica server gives the plugin public 990 lookup capability, while Kindora adds grant-level search, giving statistics, and richer foundation profiles.

## Local Validation

From the repository root:

```bash
node mcp/server.mjs
```

The server speaks MCP over stdio, so it will wait for JSON-RPC messages. To check plugin packaging from a Codex development environment, run the plugin validator:

```bash
python3 /Users/wayanvota/.codex/skills/.system/plugin-creator/scripts/validate_plugin.py .
```

## Privacy And Limits

The plugin works with public filings and user-provided organizational details. Do not enter confidential donor strategy, private board notes, or personally sensitive relationship intelligence unless your ChatGPT or Codex workspace is approved for that data.

Foundation filings can lag by more than a year, and 990 data rarely explains why a grant was made. Treat the score as a prioritization aid, not a decision engine.
