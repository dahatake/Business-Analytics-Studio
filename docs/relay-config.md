# Relay configuration (D-5)

The relay (`server/relay.ts`) is the only process that holds the Foundry API key and the only one that talks to the
generative-AI provider. It runs inside the Vite dev and preview servers (`npm run dev`, `npm run preview`) under
`/relay/*`. Every protection is on by default; environment variables can only adjust them explicitly, and invalid values
or wildcards stop the server at startup (`relayConfigFromEnv`, tested in `tests/ai-relay.test.ts`).

## Strict defaults (local PC, C-01)

| Check | Default behaviour |
|---|---|
| Client address | Only `127.0.0.1` (also in its IPv4-mapped form `::ffff:127.0.0.1`). `::1` is refused. |
| `Host` header | Must be exactly `127.0.0.1:<listening port>`. `localhost`, other ports and other names are refused (DNS rebinding). |
| `Origin` header | Must be exactly `http://127.0.0.1:<listening port>`. Requests without `Origin` are refused, except `GET /relay/status`. |
| Fetch Metadata | `Sec-Fetch-Site`, when sent, must be `same-origin` or `none`. |
| Per-launch token | 32 random bytes per server start, handed out by `POST /relay/session` (browsers always send `Origin` on POST) and required in `X-BAS-Relay` on every other route. Compared in constant time; kept in browser memory only. |
| Request bodies | JSON only (`Content-Type: application/json`), at most 1 MiB; `/relay/ai` accepts only known fields (`use`, `provider`, `lang`, `prompt`, `context`, `maxOutputTokens`, `timeoutMs`), prompt + context ≤ 32 000 characters (200 000 for "packBuild"), `maxOutputTokens` ≤ the use's cap (1500 for "explain", 16 000 for "packBuild"), `timeoutMs` ≤ 120 000 (300 000 for "packBuild"). |
| C-03 | `/relay/ai` re-checks the C-03 table: "explain" to Foundry (D-1), "packBuild" to Foundry or GitHub Copilot (D-12). D-13 approves only a fixed synthetic "connectionTest" through `PUT /relay/connection`; `/relay/ai` refuses that use. Other uses get `403 c03NotApproved`. |
| Interval | Server-side minimum interval per use (PARAM-116: 5 s for "explain") → `429 tooSoon`. |
| Outbound | AI calls use only `https` URLs whose hostname exactly equals the saved endpoint. Company news uses the fixed `https://news.google.com/rss/search` endpoint. Work IQ (D-14, Microsoft Foundry only) uses the fixed `https://login.microsoftonline.com/<tenant>/oauth2/v2.0/{devicecode,token}` and `https://workiq.svc.cloud.microsoft/rest/conversations` endpoints. Redirects are not followed. |
| Errors | Provider bodies and credentials are never returned or logged. Foundry failures report sanitized codes: DNS (`dnsFailure`), network, TLS, authentication (`unauthorized`, HTTP 401), access/network restrictions (`forbidden`, 403), API/deployment not found (404), invalid API request (400), busy/quota (429), malformed response or service failure. Only the numeric provider HTTP status is returned. Copilot retains its existing error codes. Browser cancellation aborts the upstream call. |

### Foundry: test before saving (D-13)

`PUT /relay/connection` accepts `{ endpoint, deployment, apiVersion }` and uses the **already saved API key** to send a
fixed synthetic "Reply with OK only" prompt. No caller-supplied prompt, customer pack or project data is sent.
The UI requires explicit confirmation of the displayed destination and unknown-charge notice, not unit-price entry.
It checks the daily quota, interval and known-cost monthly budget, and records token usage under `connectionTest`.
Foundry monetary costs are `null` (unknown), never zero/free. This also applies to uncertain failures that may have
been billed; DNS/authentication rejections create no inference usage record. The relay enforces the outbound allowlist, a 30-second timeout, no redirects and a
5-second interval (including concurrent tests). Output is capped at 256 tokens; a rejected modern request may be
retried once with the legacy token parameter.

Supported endpoint formats (HTTPS only, no credentials, query or fragment):

- Resource origin: `https://<resource>.openai.azure.com` or `https://<resource>.services.ai.azure.com`.
  Calls `/openai/deployments/<deployment>/chat/completions?api-version=<version>` with `api-key`.
- OpenAI v1 base: either resource host followed by `/openai/v1` (optional final slash).
  Calls `/openai/v1/chat/completions` with `model: <deployment>` and bearer API-key authentication; no dated API version.
  See [the official v1 API guide](https://learn.microsoft.com/azure/foundry/openai/api-version-lifecycle).
- Project URL: `https://<resource>.services.ai.azure.com/api/projects/<project>` (optional final slash).
  Automatically builds `https://<resource>.services.ai.azure.com/openai/v1` without changing the host.
  The UI previews the assembled Chat Completions destination and disables the unused dated API version.
  Conversion does not prove availability: the same API-key connection test must succeed before the normalized
  connection is saved. Project paths on unknown hosts, non-default ports or with extra path segments are refused;
  no project API or Entra/project authentication is used.

Only a nonempty model response with valid token usage permits saving. Failure leaves the previous connection intact.
`connection.json` contains the normalized endpoint, deployment (1–64 letters, digits, dots, underscores or hyphens),
API version (legacy default `2024-10-21`), verification time and a verification signature bound to those values and the
current key. The signature is never returned to the browser. `GET /relay/status` reports `connectionVerifiedAt`; old
settings without valid verification remain visible but **unconfigured**, and changing the key invalidates verification.
Verification survives relay restarts but is a historical check, not a guarantee of future reachability.

Foundry manual token-price settings are removed, including persisted values migrated from older versions.
Connection tests, explanations and pack generation do not require a price. Confirmation screens and saved generation
reports distinguish unknown costs from free mock answers; usage summaries show the known-cost subtotal and the count
of unpriced calls separately. The app cannot enforce a Foundry monetary billing cap without pricing; check Azure billing
and configure Azure budget alerts. Token caps, per-use daily quotas, intervals, timeouts and consent still apply.
A zero app budget blocks sends. Copilot premium-request pricing and known-cost budget enforcement are unchanged.
Story video remains mock-only and needs no Foundry price.

The master key of the vault is protected with Windows DPAPI (CurrentUser) on Windows (I-6) and is a 0600 file elsewhere or
when DPAPI is unavailable. `GET /relay/status` reports `keyProtection: 'dpapi' | 'file'`, shown on `/ai-settings`.

## Environment variables

| Variable | Default | Values | Effect |
|---|---|---|---|
| `BAS_RELAY_REQUIRE_LOOPBACK` | `1` | `0` or `1` | `0` disables the client-address check. Only for a server deployment behind a trusted reverse proxy. |
| `BAS_RELAY_ALLOW_IPV6_LOOPBACK` | `0` | `0` or `1` | `1` also accepts clients from `::1`. |
| `BAS_RELAY_ALLOWED_HOSTS` | empty | comma-separated exact `host` or `host:port` | Extra accepted `Host` header values. Compared exactly (case-insensitive). For default ports the browser sends no port, so list `bas.example.com`, not `bas.example.com:443`. |
| `BAS_RELAY_ALLOWED_ORIGINS` | empty | comma-separated exact origins | Extra accepted `Origin` values, e.g. `https://bas.example.com` (scheme + host + optional port, no trailing slash). |
| `BAS_RELAY_OUTBOUND_HOSTS` | unset | comma-separated exact hostnames | When set, the provider hostname must also be in this list. Checked when the connection is saved and again before every call. News retrieval additionally requires `news.google.com` in this list. Work IQ (D-14) is refused unless `login.microsoftonline.com` and `workiq.svc.cloud.microsoft` are both listed. GitHub Copilot (D-12) is refused unless `api.githubcopilot.com`, `api.github.com` and `github.com` are all listed, so a Foundry-only list never lets material go to GitHub. |
| `BAS_RELAY_TEST_OUTBOUND` | `0` | `0` or `1` | **Tests only.** `1` additionally allows `http://127.0.0.1:<port>` as the provider endpoint (local stub servers in `tests/ai-relay.test.ts` and `e2e/ai.spec.ts`). Never set it in normal use. |
| `BAS_RELAY_DIR` | `.bas-local` | path | Folder for `secrets.enc.json`, the master key and `connection.json`. E2E builds (`BAS_OUT=dist-x`) use `.bas-local/e2e-dist-x`. |
| `BAS_WORKIQ_CLI` | unset | path to `workiq` (or a `.js` entry) | Work IQ CLI route (D-14): the program the relay starts as `<path> mcp`. Unset runs `npx -y @microsoft/workiq@1 mcp` with npm's npx next to the relay's Node. |

Wildcards (`*`) are refused in every list. A malformed entry or a flag other than `0`/`1` stops the server with an error
that names the variable (the value is not printed).

## Company news endpoint

`POST /relay/news` accepts only `{ "company": "<public company name>", "lang": "ja" | "en" }`.
It uses the same Origin, loopback, Host, JSON-body and per-launch-token checks as the other relay routes.
No Foundry configuration, credentials or C-03 AI approval is required: this is a metadata search, not an AI call.
Only the company-name query and language/region parameters go to Google News RSS; project contents are never sent.
The host and path cannot be supplied by the client, redirects are refused, the timeout is 10 seconds, and responses
are limited to 1 MiB. RSS is validated without DTDs or custom entities; article links must be HTTP(S) without credentials.
Only title, source, publication date and link are returned; article bodies/descriptions are not retrieved or rendered.

The relay caches successful results for five minutes by company and language (up to 50 entries), coalesces identical
in-flight requests and allows up to 10 distinct concurrent searches. It deduplicates titles/URLs, sorts by publication
date, and returns at most 10 articles with `provider` and `fetchedAt`. Empty search results are successful empty arrays;
malformed feeds are errors, never fabricated articles. Failure codes are `502 newsUnavailable`, `502 invalidNewsFeed`,
`504 newsTimeout`, `429 newsBusy`, `400 invalidNewsRequest`, or `403 outboundNotAllowed`.
The browser retains a previous result only for the same target, marks refresh errors, cancels old requests on target
changes, and stops polling when the live bar is paused. The cache is process-local, not written to disk.
The browser CSP remains same-origin; RSS is fetched by the relay. Static-file-only hosting cannot provide this endpoint.

## Customer pack generation (FR-311, D-12)

**Providers.** `POST /relay/ai` takes `provider: "foundry" | "copilotSdk"` (default `foundry`).
For "packBuild" the Foundry call asks for JSON mode (`response_format: json_object`) with `max_completion_tokens`
(required by reasoning deployments); a deployment that rejects that body with HTTP 400 (not billed) is retried once with
the classic `max_tokens` body. The system prompt is the pack builder's: answer with one JSON object from the given
material only.

**GitHub Copilot** runs through `@github/copilot-sdk` in the relay process, signed in as the Copilot CLI user on this PC
(`copilot` → `/login`). The relay never sees or stores a GitHub token. Each call creates a session with **no tools**
(`availableTools: []`, every permission request rejected), the system prompt **replaced** by the pack builder's, the
session store off and an empty working directory, and deletes the session afterwards. A cancel that arrives while the session is being created sends nothing. With `BAS_RELAY_OUTBOUND_HOSTS` set, both Copilot routes answer `403 outboundNotAllowed` unless the Copilot hosts are listed. Cost is reported as premium
requests (the runtime's reported model cost, else the model multiplier).

| Route | Body | Answer |
|---|---|---|
| `POST /relay/copilot/status` | `{}` | `{ available, authenticated, login, models: [{ id, name, multiplier }], settings }` (starts the runtime when needed) |
| `PUT /relay/copilot` | `{ "model": "<id>" }` (`[A-Za-z0-9._:-]{1,64}`, no other field) | `{ copilot: { model } }`, saved in `copilot.json` next to `connection.json` |
| `DELETE /relay/copilot` | — | `{ copilot: null }` |
| `GET /relay/status` | — | also returns `copilot: { model } | null` |

**Official-site reader.** `POST /relay/site` with `{ "url": "<official site>" }` returns `{ pages: [{ url, title,
description, themeColor, text, fetchedAt }], failed: [{ url, error }] }`. Only the URL the user typed and links found on
that site are requested; nothing from the app is sent. Guards: `https` on port 443 only, no credentials and no IP-literal
hosts; **every hostname is resolved and refused when any address is loopback, private, link-local, CGNAT, multicast or
reserved** (`403 privateAddress`); redirects are followed manually (at most 3) and re-checked — the entry page may move
to another public host (a company that changed domains), every other page must stay on that site
(`403 redirectNotAllowed`); every request and every link found on a page is checked again (https, port 443, no credentials, no IP literal); `text/html` only, decoded with the declared charset (header or `<meta charset>`, e.g. Shift_JIS), 1.5 MB and 10 s per page, at most 6 pages (PARAM-145) in 10 attempts.
Pages are chosen best-first: detail pages (outline, sites, figures) before company/profile hubs, then IR, business,
history and sustainability, spreading the pages over sections; tracking parameters are dropped. When
`BAS_RELAY_OUTBOUND_HOSTS` is set, the site's host must be listed. Errors: `400 invalidUrl`, `403 privateAddress`,
`403 redirectNotAllowed`, `403 outboundNotAllowed`, `502 siteUnavailable` / `notHtml` / `tooLarge`, `504 siteTimeout`.
A DNS answer that changes between the check and the connection is not fully excluded; the relay serves this PC only
(C-01) and the caps bound the impact.
## Work IQ retrieval verification (Microsoft Foundry only)

The Work IQ section is included in both AI settings and the **Connect to AI** dialog. A refresh token only proves
sign-in, not service enablement, billing assignment or access to Microsoft 365 data. Foundry customer-pack generation
requires the separate retrieval check; ordinary Foundry explanations and GitHub Copilot SDK behavior are unchanged.
The SDK's MCP configuration is not read or modified by BAS.

The relay reaches Work IQ in one of two ways, chosen in the Work IQ section:

| Route | Who signs in | What the tenant must allow | When to use |
| --- | --- | --- | --- |
| **Work IQ CLI** (default) | Microsoft's [Work IQ CLI](https://github.com/microsoft/work-iq) (`@microsoft/workiq`) with its own Microsoft-published client and the user's Windows (WAM) or browser sign-in | Whatever the CLI already needs in that tenant; BAS adds no app registration or admin consent | The tenant will not consent to a custom app for `WorkIQAgent.Ask` (D-14, 2026-11-11), or the user's Microsoft 365 home tenant differs from the Azure subscription tenant |
| **My own app registration** (REST) | Device code with the user's public-client app | Work IQ enablement, billing assignment and admin consent for `WorkIQAgent.Ask` in the user's **home** tenant | The organisation manages its own app registration |

### Work IQ CLI route

The relay starts `workiq mcp` as a local MCP stdio server for each verification or customer retrieval and stops it
afterwards. By default it runs npm's own `npx-cli.js` next to the relay's Node (`npx -y @microsoft/workiq@1 mcp`; the
first run downloads the package from the npm registry). `BAS_WORKIQ_CLI` overrides this with an installed `workiq`
executable (or a `.js` entry run with the same Node). Before the first use, `npm run workiq:check` (also
`setup.ps1 -WorkIq` / `setup.sh --workiq`) starts the same command once, lists its tools and shows the CLI's saved
account; it calls no tool, so nothing is searched or billed and the EULA is not accepted. It exits 1 with a next action
when the CLI cannot start, times out (sign-in not finished; `--timeout <seconds>`), or offers no `retrieve`.
Only two tools are called by the relay:

- `retrieve` with `strategy: "grounding"` (read-only). Two payload shapes under
  `structuredContent["application/vnd.ms-workiq.retrieval"]` are read: the [documented contract](https://learn.microsoft.com/microsoft-365/copilot/extensibility/work-iq/mcp/retrieve)
  (top-level `markdown` with `retrievalHits[].webUrl`) and the shape `@microsoft/workiq` 1.0.x actually returned on
  2026-11-11 (`results[]`, each with its own `markdown`, `webUrl`, `entityType`, `resourceMetadata`, `sensitivityLabel`
  and `contentProtection`). Each result becomes a numbered section `[n] title (type, date) <url>` of the internal
  source and one citation; a result whose `contentProtection` is not `allowed` keeps its citation but its text is not
  passed on. HTTPS `webUrl`s only; sensitivity-label names are kept. `isError` or `stoppedReason: "error"` is a
  failure, never an empty success. Reading only the documented shape made every real verification fail with
  `workiqNoGrounding` although sources were returned; if the CLI changes its shape again, verification fails the same
  way instead of passing.
- `accept_eula` with `https://github.com/microsoft/work-iq`, only through `POST /relay/workiq/eula`
  `{ "provider": "foundry", "accept": true }`, which the UI sends when the user ticks "I have read the Work IQ EULA and
  accept it myself" next to the EULA link. Success requires the CLI to have persisted the acceptance
  (`workiq config show` → `I-accept-EULA=true`); otherwise the answer is `412 workiqEulaRequired`. Until then retrieval
  answers `412 workiqEulaRequired`. `npm run workiq:check` shows the persisted state.

The CLI's stderr is discarded (it can contain account names). A missing Node/npx or program is `503 workiqCliMissing`;
the CLI exiting early is `502 workiqUnavailable`; the 120-second limit is `504 workiqTimeout`. A CLI verification is
sealed with an HMAC keyed by a relay-only vault secret (`workiqCliKey`), so editing `workiq.json` cannot fake it;
switching routes or deleting the settings removes that key. The CLI makes its own network connections
(`login.microsoftonline.com`, `workiq.svc.cloud.microsoft`, and `registry.npmjs.org` for npx), which
`BAS_RELAY_OUTBOUND_HOSTS` cannot enforce on a child process; the relay still refuses the route when the allowlist is
set without the two Work IQ hosts.

### App registration route

1. Follow [tenant enablement](https://learn.microsoft.com/microsoft-365/copilot/extensibility/work-iq/enable-work-iq):
   a Global Administrator provisions the Work IQ enterprise application
   (`az ad sp create --id fdcc1f02-fc51-4226-8753-f668596af7f7`) and configures a Copilot Studio usage-based
   billing plan linked to an Azure subscription/resource group, assigning the user to it.
2. Register a **single-tenant public client**, enable public-client flows, and add delegated `WorkIQAgent.Ask`
   (resource app `fdcc1f02-fc51-4226-8753-f668596af7f7`, scope `0b1715fd-f4bf-4c63-b16d-5be31f9847c2`).
   Grant admin consent. See the [official registration quickstart](https://learn.microsoft.com/microsoft-365/copilot/extensibility/work-iq/a2a/quickstart).
   No client secret, extra Foundry agent or MCP server is needed.
3. Save the tenant/client IDs in BAS and sign in. The Foundry API key does **not** identify or authenticate the
   Microsoft 365 user/tenant. Do not infer the Work IQ tenant from an Azure subscription or model response.
4. Confirm the possible Copilot Credits charge and press **Verify Work IQ retrieval**.

### Verification (both routes)

`POST /relay/workiq/verify` accepts only `{ "provider": "foundry" }`. The REST route uses the same fixed endpoints,
delegated credentials, outbound allowlist, response-size cap and 120-second timeout as customer retrieval and asks for
one accessible OneDrive/SharePoint file with web grounding disabled; the CLI route runs one `retrieve` for a recent
Microsoft 365 item. A nonempty response **with an HTTPS source
citation** is required; sign-in, conversation creation or an ungrounded response alone cannot pass. This is a retrieval
smoke test, not proof of complete customer coverage or independent attestation of the cited document.
No customer name, project or attachments are sent. Retrieved text/URLs are discarded and never returned, logged,
saved in the settings or sent to Foundry by this diagnostic.

The response contains only the public Work IQ status, including `verifiedAt`. The timestamp and an HMAC bound to
the current tenant/client/refresh credential are saved in `workiq.json`; the HMAC is never exposed. Verification
survives restarts, but credential changes, new sign-in, settings changes, deletion or a failed retest invalidate it.
The UI shows sign-in and retrieval verification separately. `workiqForbidden` points to enablement/consent/billing,
`workiqNoGrounding` to missing source evidence (including absent/unindexed accessible files), and timeout, busy and
network failures remain explicit. Repeated tests have a five-second minimum interval.

Work IQ charges are separate from LLM token accounting and are unknown, not zero. A zero app budget blocks UI
diagnostics; otherwise BAS cannot enforce a yen-denominated Work IQ billing cap. For a JPY 10,000/month target,
check both Azure/Foundry and Copilot Credits charges and configure billing controls/alerts before enabling paid use.
Budget alerts alone do not stop spending. App registration itself adds no Azure compute resource or inference charge.

## Azure deployment

C-01 assumes that the app and the relay run on the user's own PC. Running them on a server changes that assumption and
needs its own approval. If it is approved, set at least:

```text
BAS_RELAY_REQUIRE_LOOPBACK=0                     # clients reach the server through the platform's front end
BAS_RELAY_ALLOWED_HOSTS=bas.example.com          # the public host name exactly as the browser sends it
BAS_RELAY_ALLOWED_ORIGINS=https://bas.example.com
BAS_RELAY_OUTBOUND_HOSTS=<resource>.openai.azure.com
```

Leave `BAS_RELAY_ALLOW_IPV6_LOOPBACK` and `BAS_RELAY_TEST_OUTBOUND` unset. Put authentication in front of the app (for
example App Service / Container Apps built-in authentication with Microsoft Entra ID): the per-launch token only proves
that a request comes from a page served by this app, not who the user is.

> **Warning: secrets then live on a server.** The relay vault (`secrets.enc.json`, the master key and DPAPI) is designed
> for one user's PC. DPAPI is not available on Linux containers, so the master key would be a plain file next to the
> secrets. On Azure, do not store the API key in the relay vault: keep it in Azure Key Vault and let the app read it with a
> managed identity, or better, use Microsoft Entra ID authentication to Microsoft Foundry with a managed identity so there is
> no key at all. Both need a code change in `server/relay.ts` (the key source) and an approval of C-01 for server use.

The Content Security Policy is handled separately by the integrator (I-5) and is not configured here.
