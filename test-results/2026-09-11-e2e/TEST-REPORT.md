# End-to-End Test Report

Repository: `wayanvota/funder-discovery-plugin`  
Branch: `test/e2e-harness-2026-09-11`  
Date: 2026-09-11  
Environment: macOS, Node 22.16.0; CI pinned to Node 22.16.0

## Result

PASS. All 20 end-to-end categories passed. The existing Actions checks, the
existing MCP registration check, JavaScript syntax checks, and the npm
dependency audit also passed. The audit reported zero vulnerabilities.

Before this change, `check:mcp` slept for 750 milliseconds and inspected only
tool names. Actions tests imported functions in-process. No test exercised the
complete process, protocol, upstream HTTP, or Actions HTTP boundaries.

## Test boundary

The harness starts both MCP entry points as child processes and exchanges real
newline-delimited MCP JSON-RPC over stdio. A temporary HTTP fixture replaces
ProPublica and Kindora. It separately starts the Actions server in mock mode and
uses real HTTP requests. No production credential or external network is used.

## User-behavior categories

| ID | Behavior | Final |
| --- | --- | --- |
| U01 | Initialize the ProPublica MCP subprocess | PASS |
| U02 | Discover all four read-only ProPublica tools | PASS |
| U03 | Search across stdio and upstream HTTP | PASS |
| U04 | Normalize an EIN and return organization filings | PASS |
| U05 | Fetch and cap filing XML | PASS |
| U06 | Initialize the Kindora MCP subprocess | PASS |
| U07 | Discover nine read-only Kindora tools and forward authorization | PASS |
| U08 | Call a Kindora tool through the configured upstream | PASS |
| U09 | Serve Actions health and OpenAPI over HTTP | PASS |
| U10 | Complete a mock discovery workflow with download links | PASS |

## Adversarial categories

| ID | Behavior | Final |
| --- | --- | --- |
| A01 | Ignore malformed MCP input and remain available | PASS |
| A02 | Reject an unknown MCP method | PASS |
| A03 | Reject an unknown MCP tool | PASS |
| A04 | Reject a malformed EIN before any upstream request | PASS |
| A05 | Reject search text over 500 characters | PASS |
| A06 | Reject filing XML on an unapproved host | PASS |
| A07 | Reject an out-of-range Kindora argument locally | PASS |
| A08 | Return a generic, secret-safe Kindora upstream failure | PASS |
| A09 | Return HTTP 400 for malformed Actions JSON | PASS |
| A10 | Return HTTP 413 over 1 MiB and keep process output secret-safe | PASS |

## Failures found and fixed

1. The Actions service read request bodies without a size limit. Requests are
   now capped at 1 MiB and return a specific 413 response.
2. Invalid Actions JSON was reported as an internal server failure. It now
   returns a specific 400 response without echoing the submitted content.
3. The ProPublica filing tool accepted any HTTP or HTTPS URL. It now requires
   HTTPS and an explicit IRS or ProPublica host allowlist. A test-only HTTP flag
   supports the loopback fixture.
4. Kindora arguments were forwarded without local schema enforcement. The
   proxy now validates types, ranges, enums, required values, text length, EIN
   format, extra properties, and list size before calling the upstream.
5. Kindora failures could expose an upstream error message. External responses
   are now generic, and logs do not include upstream response bodies.
6. Live Kindora discovery advertised tools outside the plugin's documented and
   callable nine-tool surface. Discovery now applies the same reviewed
   allowlist as dispatch, and the fixture includes an unreviewed upstream tool
   to prevent this contract from drifting again.

The first runnable E2E pass reported 16 passes and four failures. Three failures
were corrected fixture assumptions. The remaining proxy failures were caused
by a test timeout expressed as 2 milliseconds instead of 2 seconds. The fixed
harness then passed all 20 categories.

## Verification evidence

```text
$ npm test
Actions check passed.
Pilot test plan passed.
ProPublica MCP check passed
Kindora MCP check passed
20 E2E tests passed in 1.23 seconds

$ /usr/local/bin/node --version
v22.16.0

$ /usr/local/bin/node --test --test-concurrency=1 tests/e2e.test.mjs
20 passed in 1.27 seconds

$ npm audit --audit-level=high
found 0 vulnerabilities

$ node --check mcp/server.mjs
$ node --check mcp/kindora-server.mjs
$ node --check actions/action-server.mjs
$ node --check tests/e2e.test.mjs
all exited 0

$ validate_plugin.py .
Plugin validation passed
```

## Known boundary

The suite proves local plugin behavior, process startup, protocol handling,
proxying, and mock Actions behavior. It does not assert the current availability
or data quality of Kindora or ProPublica. Those external services remain an
operational dependency and should not make pull-request CI nondeterministic.
