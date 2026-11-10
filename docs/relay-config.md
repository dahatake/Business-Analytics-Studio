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
| C-03 | `/relay/ai` re-checks the C-03 table: only approved rows and providers are forwarded — "explain" to Foundry (D-1), "packBuild" to Foundry or GitHub Copilot (D-12). Anything else gets `403 c03NotApproved`. |
| Interval | Server-side minimum interval per use (PARAM-116: 5 s for "explain") → `429 tooSoon`. |
| Outbound | AI calls use only `https` URLs whose hostname exactly equals the saved endpoint. Company news uses the fixed `https://news.google.com/rss/search` endpoint. Redirects are not followed. |
| Errors | Provider bodies are never returned or logged; the browser gets `502 providerError`, `502 providerBusy` (429), `502 badProviderResponse`, `504 timeout`, or, for Copilot, `503 notSignedIn` / `503 sdkUnavailable`. When the browser cancels (closes the request), the upstream call is aborted too. |

The non-secret connection (endpoint origin, deployment, API version; default `2024-10-21`) is saved with
`PUT /relay/connection` in `connection.json` next to the encrypted key vault. The endpoint must be an `https` URL without
credentials, path, query or fragment; the deployment name must match `[A-Za-z0-9._-]{1,64}`. "Configured" means that the
relay holds the endpoint, the deployment and the API key.

The master key of the vault is protected with Windows DPAPI (CurrentUser) on Windows (I-6) and is a 0600 file elsewhere or
when DPAPI is unavailable. `GET /relay/status` reports `keyProtection: 'dpapi' | 'file'`, shown on `/ai-settings`.

## Environment variables

| Variable | Default | Values | Effect |
|---|---|---|---|
| `BAS_RELAY_REQUIRE_LOOPBACK` | `1` | `0` or `1` | `0` disables the client-address check. Only for a server deployment behind a trusted reverse proxy. |
| `BAS_RELAY_ALLOW_IPV6_LOOPBACK` | `0` | `0` or `1` | `1` also accepts clients from `::1`. |
| `BAS_RELAY_ALLOWED_HOSTS` | empty | comma-separated exact `host` or `host:port` | Extra accepted `Host` header values. Compared exactly (case-insensitive). For default ports the browser sends no port, so list `bas.example.com`, not `bas.example.com:443`. |
| `BAS_RELAY_ALLOWED_ORIGINS` | empty | comma-separated exact origins | Extra accepted `Origin` values, e.g. `https://bas.example.com` (scheme + host + optional port, no trailing slash). |
| `BAS_RELAY_OUTBOUND_HOSTS` | unset | comma-separated exact hostnames | When set, the provider hostname must also be in this list. Checked when the connection is saved and again before every call. News retrieval additionally requires `news.google.com` in this list. GitHub Copilot (D-12) is refused unless `api.githubcopilot.com`, `api.github.com` and `github.com` are all listed, so a Foundry-only list never lets material go to GitHub. |
| `BAS_RELAY_TEST_OUTBOUND` | `0` | `0` or `1` | **Tests only.** `1` additionally allows `http://127.0.0.1:<port>` as the provider endpoint (local stub servers in `tests/ai-relay.test.ts` and `e2e/ai.spec.ts`). Never set it in normal use. |
| `BAS_RELAY_DIR` | `.bas-local` | path | Folder for `secrets.enc.json`, the master key and `connection.json`. E2E builds (`BAS_OUT=dist-x`) use `.bas-local/e2e-dist-x`. |

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
> managed identity, or better, use Microsoft Entra ID authentication to Azure OpenAI with a managed identity so there is
> no key at all. Both need a code change in `server/relay.ts` (the key source) and an approval of C-01 for server use.

The Content Security Policy is handled separately by the integrator (I-5) and is not configured here.
