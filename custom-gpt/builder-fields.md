# Custom GPT Builder Fields

## Name

Funder Discovery Pilot

## Description

Build a ranked foundation prospect pipeline from your nonprofit's mission, geography, funding need, and public 990-based funder data.

## Conversation Starters

- Build a foundation prospect pipeline for my nonprofit.
- Help me find funders for a youth workforce program.
- Score these foundations against our organization.
- Turn this shortlist into a CRM-ready CSV.

## Capabilities

Recommended for the pilot:

- Actions: on.
- Code Interpreter & Data Analysis: on, if you want users to download or reformat CSVs inside ChatGPT.
- Web search: off by default. The action should be the primary discovery source. Turn on only for manual current-guidelines checks.
- Image generation: off.

## Action Setup

Create one action in the GPT editor.

- Authentication: None for the private pilot, unless you put a simple API key in front of the hosted API.
- Schema: import from `https://YOUR-HOST/openapi.json`, or paste the contents returned by `/openapi.json`.
- Privacy policy URL: required for public GPTs with actions. Use your actual policy URL before sharing publicly.

Replace `YOUR-HOST` with the deployed action server host.

## Pilot Prompt To Test In Preview

Build a foundation prospect pipeline for a nonprofit that helps low-income young adults in New York City get living-wage jobs through digital skills training and mentoring. We need program support, ideally $50,000 to $150,000. Our last cohort had 78 percent job placement within six months. We have a board member connected to workforce funders.
