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
| Request bodies | JSON only (`Content-Type: application/json`), at most 1 MiB; `/relay/ai` accepts only known fields (`use`, `provider`, `lang`, `prompt`, `context`, `maxOutputTokens`, `timeoutMs`, `stage`), prompt + context ≤ 32 000 characters (200 000 for "packBuild" and the all-step batch uses "deliverableDraft", "solutionDraft", "stepBrief", "strategyOverview", "objectiveDraft", "kpiOkrDraft", D-41, D-42, D-44, D-46), `maxOutputTokens` ≤ the use's cap (1500 for "explain", 16 000 for "packBuild", "stepBrief" and "objectiveDraft", 32 000 for "deliverableDraft", "solutionDraft" and "strategyOverview"), `timeoutMs` ≤ 120 000 (300 000 for "packBuild", "deliverableDraft", "solutionDraft", "stepBrief", "strategyOverview", "objectiveDraft" and "kpiOkrDraft"). |
| C-03 | `/relay/ai` validates the request-use identifier and provider-specific technical limits, then re-checks the broad AI-settings consent, configured connection, live switch, and safety-limit gates (token caps, interval, daily calls; no monetary budget). There is no per-use approval table. A connection test remains a separate fixed synthetic request through `PUT /relay/connection`; it never includes customer or project data. |
| Interval | Server-side minimum interval per use (PARAM-116: 5 s for "explain") → `429 tooSoon`. The all-step batch uses ("deliverableDraft", "solutionDraft", "stepBrief", "strategyOverview", "objectiveDraft", "kpiOkrDraft") have no interval (D-41, D-42, D-44, D-46). |
| Outbound | AI calls use only `https` URLs whose hostname exactly equals the saved endpoint. Company news uses the fixed `https://news.google.com/rss/search` endpoint. Work IQ (D-14: Microsoft Foundry, or GitHub Copilot when the user opts in) uses the fixed `https://login.microsoftonline.com/<tenant>/oauth2/v2.0/{devicecode,token}` and `https://workiq.svc.cloud.microsoft/rest/conversations` endpoints. Redirects are not followed. |
| Errors | Provider bodies and credentials are never returned or logged. Foundry failures report sanitized codes: DNS (`dnsFailure`), network, TLS, authentication (`unauthorized`, HTTP 401), access/network restrictions (`forbidden`, 403), API/deployment not found (404), invalid API request (400), busy/quota (429), malformed response or service failure. Only the numeric provider HTTP status and an optional numeric retry delay are returned. Copilot retains its existing error codes. Browser cancellation aborts the upstream call. |

For Foundry HTTP 429 the relay also returns a sanitized numeric retry delay from `Retry-After` or the millisecond retry
headers, when present. Pack generation honors that delay, with at most two retries per run; waits above 60 seconds
are reported instead of retried automatically. Without a provider delay, its busy retries wait 15 then 30 seconds.
Quota or capacity errors can persist even after a short connection test succeeds.

### Foundry: test before saving (D-13)

`PUT /relay/connection` accepts `{ endpoint, deployment, apiVersion }` and uses the **already saved API key** to send a
fixed synthetic "Reply with OK only" prompt. No caller-supplied prompt, Project pack or project data is sent.
The UI requires explicit confirmation of the displayed destination, not unit-price entry.
It checks the daily quota and interval, and records token usage under `connectionTest`. When the provider reports no
usage, or the call may have consumed tokens before it failed, the record is the app's estimate and is marked
`estimated`; it is never shown as a provider-reported figure. DNS/authentication rejections create no inference usage record. The relay enforces the outbound allowlist, a 30-second timeout, no redirects and a
5-second interval (including concurrent tests). Output is capped at 256 tokens; a rejected modern request may be
retried once with the legacy token parameter.

On Node.js with OpenSSL 3.5 or later, the relay advertises X25519 first for Foundry inference to avoid
TLS handshake resets on some network paths. It still offers the hybrid key exchange group and keeps
TLS 1.3 and certificate verification enabled. Model discovery through Azure Resource Manager uses a separate connection.

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
  no project API or project authentication is used. Microsoft Entra ID is available for resource endpoints with a
  custom subdomain (see [Microsoft Entra ID for Microsoft Foundry](#microsoft-entra-id-for-microsoft-foundry)).

Only a nonempty model response with valid token usage permits saving. Failure leaves the previous connection intact.
`connection.json` contains the normalized endpoint, deployment (1–64 letters, digits, dots, underscores or hyphens),
API version (legacy default `2024-10-21`), verification time and a verification signature bound to those values and the
current key. The signature is never returned to the browser. `GET /relay/status` reports `connectionVerifiedAt`; old
settings without valid verification remain visible but **unconfigured**, and changing the key invalidates verification.
Verification survives relay restarts but is a historical check, not a guarantee of future reachability.

**Budget management was removed.** The app no longer has a monthly budget, warn/stop ratios, unit prices, JPY cost
estimates, a cost ledger, retention/prune controls or story pricing. Old settings (`monthlyBudgetJpy`, prices) are
dropped on migration, and old usage records that carry a `costJpy` field still load; the field is ignored.
Charges are never calculated or capped by the app: check Azure billing (and configure Azure budget alerts) for Microsoft
Foundry and GitHub billing for GitHub Copilot.

What remains are safety guards, not budgets: per-call input/output token caps, the minimum interval between calls and
the per-use daily call count (`PER_USE_LIMITS`), plus consent and timeouts. The uses of the all-step batch draft
("deliverableDraft", "solutionDraft", "stepBrief", "strategyOverview", and "objectiveDraft" for business objectives, D-42, and "kpiOkrDraft" for KPI/OKR drafts and their estimated fields, D-46) keep only their output cap: no daily count, interval or input-token cap (D-41, D-44).

### Token usage per job

Every live call is logged in the browser (`bas.ai.ledger`) with its time, use, scope, stage, provider and tokens; the log
holds no prompt or answer. Each job UI (Project pack generation, batch and step drafts, brief, strategy overview and so on)
shows the input, output and total tokens of **that job only**:

- Microsoft Foundry (including Azure AI / Azure OpenAI endpoints): `usage.prompt_tokens` / `completion_tokens` of the
  chat-completions answer. If a deployment omits or garbles them, the relay returns `null` tokens (shown as **unknown**);
  it does not estimate.
- GitHub Copilot: the sum of the SDK's `assistant.usage` events. If any event lacks tokens, the job's tokens are unknown.
- A cancelled or timed-out call that may have consumed tokens is logged with the app's estimate and marked **estimated**;
  summaries label every line or total that includes one.

### HTML stories

The standalone assistant's HTML story generator was retired on 2026-11-27. The relay no longer accepts `storyVideo`
requests. This does not affect the separate story creation action on the Presentation screen.

### Vault protection

The master key of the vault is protected with Windows DPAPI (CurrentUser) on Windows (I-6) and is a 0600 file elsewhere or
when DPAPI is unavailable. `GET /relay/status` reports `keyProtection: 'dpapi' | 'file'`, shown in the AI settings dialog.

## Microsoft Entra ID for Microsoft Foundry

FR-323. In AI Settings → Microsoft Foundry, choose **Microsoft Entra ID** instead of **API key** (API keys keep working).

1. **Sign in once.** `POST /relay/entra/signin` starts an authorization-code + PKCE sign-in with a loopback redirect
   (`http://localhost:<random port>`) and returns the `https://login.microsoftonline.com/…` URL; the UI opens it in the
   default browser and polls `GET /relay/status` (`entra: { signedIn, account, tenantId, signIn: { status } }`).
   The public client is Azure CLI's (`04b07795-8ddb-461a-bbee-02f9e1bf7b46`, the same one Azure Identity uses for developer
   sign-in), so no app registration is needed. Set `BAS_ENTRA_CLIENT_ID` to use your own public client (add
   `http://localhost` as a mobile/desktop redirect URI and the delegated `Azure Service Management` and
   `Cognitive Services` permissions).
2. **Pick a directory (tenant), then a resource.** `POST /relay/entra/tenants` reads the account's ARM tenant list,
   including continuation pages. A directory and tenant refer to the same selection here. If the desired guest directory
   is absent, enter its tenant ID; access is still subject to the user's Azure permissions. The selected tenant may
   require its own sign-in (MFA or conditional access): use the selected tenant's sign-in button, then retry.
   The relay selects that tenant's MSAL account profile, not just its authority URL. If the profile is not yet cached,
   it refreshes against the selected tenant instead of reusing a home-tenant access token. Returned tokens must match
   the requested tenant for both resource discovery and Foundry inference.
   `POST /relay/entra/instances { tenantId }` queries Azure Resource Graph with that tenant's token for Microsoft Foundry
   resources (`Microsoft.CognitiveServices/accounts` of kind `AIServices`), following continuation pages. Failures are
   shown rather than treated as an empty list. Standalone Azure OpenAI resources (kind `OpenAI`) are not included.
   Switching directories clears the unsaved resource selection; it does not replace the connection saved in the relay.
   Only resources with a custom subdomain can use Entra ID; their endpoint is
   `https://<subdomain>.openai.azure.com/openai/v1`. Others are listed but disabled.
3. **Pick a deployment.** `POST /relay/entra/inspect { resourceId, tenantId }` returns the succeeded chat deployments
   (`gpt-6.2-sol` first, then `model-router`, then other `chat-latest` models) and `access: { canCall, canAssign }` from the ARM permissions
   API. Being Owner/Contributor does **not** allow data-plane calls. If `canCall` is false and `canAssign` is true,
   **Assign role** (`POST /relay/entra/role`) assigns *Cognitive Services OpenAI User* to the signed-in user on that
   resource only, then re-checks. Nothing is assigned without that click; Azure can take up to ~5 minutes to apply it.
4. **Test and save.** `PUT /relay/connection { endpoint, deployment, auth: 'entraId', tenantId }` runs the same synthetic
   connection test with `Authorization: Bearer <token for https://cognitiveservices.azure.com/.default>` and no
   `api-key`. The verification signature additionally binds `entraId`, the tenant and the signed-in account, using a
   vault-only key (`foundryEntraKey`). Signing out (`DELETE /relay/entra`), switching account or editing
   `connection.json` makes the connection unconfigured again.

Tokens never reach the browser. The MSAL token cache (refresh token included) is stored as the internal vault secret
`entraTokenCache` (≤ 1 MiB), encrypted with the DPAPI-protected master key, and `entra.json` keeps only the account
id, user name and home tenant. Later launches get tokens silently; the user signs in again only when the refresh token
expires or is revoked (the UI then shows `interactionRequired`). Sign-in uses
`login.microsoftonline.com`; listing, inspecting and role assignment use `management.azure.com`. When
`BAS_RELAY_OUTBOUND_HOSTS` is set, both must be listed or these routes return `403 outboundNotAllowed`, and the
resource host (`<subdomain>.openai.azure.com`) must be listed as for API keys. Resource IDs are validated to
`/subscriptions/<guid>/resourceGroups/<name>/providers/Microsoft.CognitiveServices/accounts/<name>` and tenant IDs
to GUIDs before any call.

For a new resource, prefer `disableLocalAuth: true` (keys off) with a custom subdomain, and give each user only the
*Cognitive Services OpenAI User* role.

## Microsoft Foundry Decision

FR-325 / D-37. In **AI Settings → Microsoft Foundry**, the **Decision model** picker sits directly below the LLM
deployment after the common Foundry connection is verified. Choose an existing deployment to save it immediately, or **Do not use** to
remove it. There are no Decision endpoint/key fields, manual deployment-name input, test consent, test/save/delete
buttons, prices or separate status panel. API key and Entra ID both reuse the common resource and authentication.

**Test connection and save** runs one LLM test and returns the Decision, Speech and Vision checks with
the saved connection (`PUT /relay/connection` with `checkServices: true`). Optional service failures are reported
separately and do not undo a successful LLM save. For an existing connection, `POST /relay/foundry/services {}`
performs the same read-only checks when settings open and no matching result from a save is available:

- **Entra ID:** find the saved resource in its tenant through Resource Graph; read the effective Speech/Vision data
  actions and succeeded `Microsoft-Decision-*` deployments. For Decision, check the documented `MaaS/*` model
  permissions, not the OpenAI chat role. Ignore exclusions for unrelated actions such as fine-tuning.
  Narrow/custom grants or exclusions that cannot establish this access remain
  unknown rather than declaring them absent. These checks do not assign roles or guarantee inference/network success.
- **API key:** read the free Speech voices list, Vision's `GET /vision/v3.2/models`, and
  `GET https://<resource>.services.ai.azure.com/openai/deployments?api-version=2024-10-21`.
  The Vision metadata check verifies resource access, not Image Analysis 4.0 regional support or OCR quality.
- Results are `available`, `unavailable` or `unknown` independently for Speech, Vision and Decision, plus the Decision
  deployment list. No image, business data, synthesized speech or inference question is sent. Outbound allowlists and
  timeouts still apply; malformed/incomplete responses and network/server failures stay **unknown**, never "missing".
- Missing resources, unreadable resources, missing service permissions and empty Decision deployment lists produce
  one concise message naming the affected services and asking the administrator to set them up in Azure. Successful
  checks add no explanatory panels. Temporary failures get a separate retry message.

`PUT /relay/decision/model { deployment: "<name>" | null }` rechecks the read-only list and only saves a succeeded
Decision deployment from the current resource. It rejects resource/account/key changes during the check and keeps
the old selection on failure. `null` removes the selection and Decision key without any outbound call.
There is **no paid synthetic inference test** on selection or opening settings. Actual Decision calls still require
the app's send consent, live mode and safety limits. If inference subsequently returns 401/403/404, its saved status records
`accessError: "resourceUnavailable"` and stops further calls until re-selection; settings shows the administrator
message even when resource discovery still succeeds.

`decision.json` contains no key or token. Its HMAC binds the selected deployment to the common key, or for Entra ID the
resource endpoint, deployment, resource tenant and signed-in account (including its tenant), sealed with the shared
vault-only `foundryEntraKey`. `verifiedAt` now means the time of the selection's read-only check, not an inference test.
Sign-out removes that seal key, so signing back in requires selecting the model again.
The saved Decision connection is usable only while the common Foundry connection is verified and its resource,
authentication and tenant still match; API-key connections must also use the current Foundry key. Old standalone
Decision settings cannot silently use a different resource; select the model on the current common resource before use.
Account changes or tampered settings invalidate verification. Expired-token and conditional-access errors are returned
explicitly; an Entra connection never falls back to an API key. Both methods share the existing consent, live-mode and safety-limit gates.

When an outbound allowlist is configured, include the Decision resource host; Entra ID also needs the existing
`login.microsoftonline.com` and `management.azure.com` entries.
The older `PUT /relay/decision` synthetic-test API remains for compatibility, but no settings control uses it.
See Microsoft's [Decision API authentication examples](https://learn.microsoft.com/azure/foundry/foundry-models/how-to/use-foundry-models-microsoft-decision#call-the-decision-api).
Deployment-list API-key authentication is documented in [Foundry authentication](https://learn.microsoft.com/azure/foundry/concepts/authentication-authorization-foundry#authentication-methods).
The model permission namespace is documented in [keyless Foundry authentication](https://learn.microsoft.com/azure/foundry/foundry-models/how-to/configure-entra-id#required-azure-roles-and-permissions).

## Azure AI Speech and Azure AI Vision

FR-328 (replaces FR-324's separate connections and FR-329's Speech override). In **AI Settings → Microsoft Foundry**,
AI Speech and AI Vision have **no settings items**, test buttons, consent controls or role-assignment controls.
Their resource/access checks run read-only with the Decision model picker described above; only failures are displayed.
The common resource applies to chat and all three services, including Decision. A Foundry resource (kind `AIServices`) serves Azure OpenAI and the
Foundry Tools, Speech and Vision included, with one key and one custom subdomain. The feature switches that would use
them stay off until C-07 is resolved. Removing the settings does not enable these features.

- **Destination.** Derived from the Foundry endpoint's custom subdomain: `https://<name>.openai.azure.com`,
  `https://<name>.services.ai.azure.com` or `https://<name>.cognitiveservices.azure.com` all map to
  `https://<name>.cognitiveservices.azure.com`. Any other host (API Management, a proxy) reports `unsupportedHost`; no
  Foundry connection reports `noConnection`. An Azure OpenAI resource (kind `OpenAI`) shares the subdomain pattern but
  answers only OpenAI APIs, so only the live test decides whether Speech / Vision work.
- **Authentication.** The same as Foundry: **API key** sends `Ocp-Apim-Subscription-Key` with the vault's `foundryKey`;
  **Microsoft Entra ID** sends `Authorization: Bearer <token for https://cognitiveservices.azure.com/.default>` of the
  signed-in account and the Foundry tenant. The Foundry role *Cognitive Services OpenAI User* does not cover Speech or
  Vision. The legacy `POST /relay/media/<service>/access` (Entra ID only, empty body) finds the connected resource in the Foundry
  tenant by its subdomain and reports the service's data-plane access; `POST /relay/media/<service>/role` assigns, on
  request only, *Cognitive Services Speech User* (`f2dc8367-1007-4938-bd23-fe263f013447`) for Speech or *Cognitive
  Services User* (`a97b65f3-24c7-4388-baec-2e87135dc908`) for Vision, which has no narrower built-in data-plane role
  (this role can also list keys; prefer `disableLocalAuth: true` on the resource).
- **Legacy diagnostic API (not used by settings).** `PUT /relay/media/<service>` with an empty body checks `BAS_RELAY_OUTBOUND_HOSTS` (the derived host must be
  listed; for Entra ID also the Entra hosts), allows one test per service every 5 s, and calls the service: Speech
  `GET …/tts/cognitiveservices/voices/list` (free), Vision
  `POST …/computervision/imageanalysis:analyze?api-version=2024-02-01&features=read` with a blank 64×64 PNG (one billed
  transaction; Image Analysis 4.0 is offered in some regions only and retires on 2028-09-25). Only a successful answer
  is saved to `media.json`, as a signature bound to the derived endpoint, the auth method and the Foundry key, or for
  Entra ID the signed-in account (vault key `foundryEntraKey`). Changing the Foundry key, endpoint or auth method,
  signing out or switching account shows the service as unverified; `DELETE /relay/media/<service>` removes the check.
  `GET /relay/status` returns `media: { endpoint, auth, unavailable, speech, vision }` (`speech` / `vision` are the
  verification time or `null`) and never a key or a token.
- **Upgrade.** `GET /relay/status` deletes FR-324's vault secrets `speechKey` and `visionKey`, FR-329's `speechSeparateKey`,
  and the retired `speech.json`. No old separate route is used or automatically verified. The settings store
  (version 6) drops the old Speech endpoint, region and drafts. Opening settings starts only the read-only checks above.
- **MAI models (D-31, checked 2026-11-19).** Not used. MAI-Voice-2.1 / MAI-Voice-2.1-Flash are preview voices served by
  the same Speech API (`<locale>-<name>:MAI-Voice-2.1` in SSML), and they have no `ja-JP` voice: the voices list of a
  Japan East Foundry resource returned 289 MAI voices in 26 locales and none in `ja-JP`. No MAI model reads text from
  images (MAI-Image generates images; MAI-Thinking-1 takes text only), so Vision stays. The app has no speech-to-text
  feature, so MAI-Transcribe does not apply. To recheck, look for `ja-JP` voices with `MAI-Voice` in their name in the
  same free voices list that the Speech test calls.

### Separate Azure AI Speech connection (FR-329)

**Retired on 2026-11-20 by explicit user request.** Speech always uses the shared Foundry resource. The separate
connection form, regional endpoint/key entry and route switch have been removed. The old `/relay/speech/route` and
`/relay/speech/separate` endpoints return `410 separateSpeechRemoved` without contacting Azure.
For older clients, status retains `speechConnection: { route: 'foundry', eligible: false, separate: null }`.
The shared Speech test must succeed before the service is considered configured; migration never grants verification.

## Environment variables

| Variable | Default | Values | Effect |
|---|---|---|---|
| `BAS_RELAY_REQUIRE_LOOPBACK` | `1` | `0` or `1` | `0` disables the client-address check. Only for a server deployment behind a trusted reverse proxy. |
| `BAS_RELAY_ALLOW_IPV6_LOOPBACK` | `0` | `0` or `1` | `1` also accepts clients from `::1`. |
| `BAS_RELAY_ALLOWED_HOSTS` | empty | comma-separated exact `host` or `host:port` | Extra accepted `Host` header values. Compared exactly (case-insensitive). For default ports the browser sends no port, so list `bas.example.com`, not `bas.example.com:443`. |
| `BAS_RELAY_ALLOWED_ORIGINS` | empty | comma-separated exact origins | Extra accepted `Origin` values, e.g. `https://bas.example.com` (scheme + host + optional port, no trailing slash). |
| `BAS_RELAY_OUTBOUND_HOSTS` | unset | comma-separated exact hostnames | When set, the provider hostname must also be in this list. Checked when the connection is saved and again before every call. News retrieval additionally requires `news.google.com` in this list. Work IQ (D-14) is refused unless `login.microsoftonline.com` and `workiq.svc.cloud.microsoft` are both listed. GitHub Copilot (D-12) is refused unless `api.githubcopilot.com`, `api.github.com` and `github.com` are all listed, so a Foundry-only list never lets material go to GitHub. Microsoft Entra ID for Foundry (FR-323) needs `login.microsoftonline.com` and `management.azure.com`. |
| `BAS_ENTRA_CLIENT_ID` | Azure CLI public client | application (client) ID | Public client used for Microsoft Entra ID sign-in (FR-323). |
| `BAS_RELAY_TEST_OUTBOUND` | `0` | `0` or `1` | **Tests only.** `1` additionally allows `http://127.0.0.1:<port>` as the provider endpoint (local stub servers in `tests/ai-relay.test.ts` and `e2e/ai.spec.ts`). Never set it in normal use. |
| `BAS_RELAY_DIR` | `.bas-local` | path | Folder for `secrets.enc.json`, the master key and `connection.json`. E2E builds (`BAS_OUT=dist-x`) use `.bas-local/e2e-dist-x`. It also holds the device database and `storage-location.json` (the data folder chosen in Settings, FR-339); secrets never move with the data folder. |
| `BAS_DEVICE_DIR` | unset | absolute path | Pins the device database folder. While set, the Settings data-folder picker cannot change it. |
| `BAS_WORKIQ_CLI` | unset | path to `workiq` (or a `.js` entry) | Work IQ CLI route (D-14): the program the relay starts as `<path> mcp`. Unset runs `npx -y @microsoft/workiq@1 mcp` with npm's npx next to the relay's Node. |

Wildcards (`*`) are refused in every list. A malformed entry or a flag other than `0`/`1` stops the server with an error
that names the variable (the value is not printed).

## Proxy and certificates on customer PCs (FR-372)

Every outbound call of the relay process goes through one routing dispatcher (`server/network.ts`). That covers
Foundry, Microsoft Entra ID (MSAL), Azure Resource Manager, Work IQ, public research and news. For each host, the
dispatcher picks a direct connection or a proxy. Loopback is always direct. The proxy comes from the first source that
is set, in this order:

1. BAS settings: `BAS_PROXY`, `BAS_PAC_URL` and `BAS_NO_PROXY`. The portable package also reads them from `network.json`.
2. The standard variables `HTTPS_PROXY`, `HTTP_PROXY` and `NO_PROXY`, in either case.
3. The operating system settings:
   - Windows: Internet Options, including the machine-wide policy, the automatic configuration script (PAC) and WPAD (`http://wpad/wpad.dat`).
   - macOS: the network settings, read with `scutil --proxy`.
4. A direct connection.

| Variable | Values | Effect |
|---|---|---|
| `BAS_PROXY` | `http://host:port`, `host:port`, `https://…`, `socks5://…`, `system`/`auto`, `direct` | Fixed proxy for every outbound host. Basic credentials may be in the URL. They are never shown in the UI or the logs. `system` skips the standard variables and uses the operating system settings. `direct` turns proxies off. |
| `BAS_PAC_URL` | `http(s)://…` or `file://…` | PAC script. It runs in a sandbox with a time limit. If the script cannot be loaded, the manual proxy is used, or else a direct connection. |
| `BAS_NO_PROXY` | comma-separated hosts, `.suffix`, `*.suffix`, `host:port`, IP/CIDR | Hosts that bypass a fixed proxy. |
| `BAS_SYSTEM_CA` | `1` (default) or `0` | `1` adds the operating system certificate store to Node's bundled roots. This covers the Windows certificate store and the macOS keychain. It lets corporate TLS inspection work without turning off certificate checks. `NODE_EXTRA_CA_CERTS` is also honoured. |

Child processes use the same route. These are the GitHub Copilot runtime and the Work IQ CLI started through npx. They
receive the resolved proxy as `HTTPS_PROXY`/`HTTP_PROXY`/`NO_PROXY` and the trusted roots as `NODE_EXTRA_CA_CERTS`
(`system-ca.pem` in the data folder).

Proxies that require NTLM or Kerberos (Negotiate) authentication are not supported. The relay reports a `407` as
"proxy authentication required" and asks for an unauthenticated route or Basic credentials. Ask IT to allow the
outbound hosts listed under `BAS_RELAY_OUTBOUND_HOSTS`, or run a local authenticating proxy (for example Px) and point
`BAS_PROXY` at it.

AI settings show the route in use (direct, proxy or PAC, and where it came from). They do not show credentials or the
PAC query. The settings also have a check that opens each outbound host in use (`POST /relay/network/check`) and names
the failure for each host: proxy authentication, proxy error, DNS, TLS (certificate), timeout or network.

## Portable package for customer PCs (FR-373, D-47)

`npm run package:portable -- --target win-x64,win-arm64,mac-arm64,mac-x64,linux-x64,linux-arm64` writes
`release/BusinessAnalyticsStudio-<version>-<commit>-<target>.zip` and a `.sha256` file for each target. The packager
does the following:

1. Builds the app.
2. Bundles the server (`server/main.ts` → `server/main.mjs`). Native and large modules stay external: MSAL, the
   Copilot SDK, undici, zod and fast-xml-parser.
3. Downloads the official Node runtime and checks it against `SHASUMS256.txt`. The download is cached under
   `.bas-local/portable/node-cache` and goes through the same proxy detection.
4. Installs the external modules from the lock file (`npm ci --omit=dev --ignore-scripts`) for the target OS and CPU.

Other options:

- `--no-copilot` leaves out the GitHub Copilot runtime, which is about 180 MB. The Copilot provider then reports that
  it is unavailable.
- `--node <version>` pins the Node runtime version.
- `--skip-build` reuses an existing `dist`.

The customer extracts the zip and starts `start.cmd` (Windows), `start.command` (macOS) or `start.sh` (Linux). Nothing
is installed, and no administrator rights are needed. The launcher behaves as follows:

- Serves the app and the relay on `127.0.0.1`, from the first free port in 4300–4309, and opens the browser.
- Keeps all data in a per-user folder outside the extracted folder:
  - Windows: `%LOCALAPPDATA%\BusinessAnalyticsStudio`
  - macOS: `~/Library/Application Support/BusinessAnalyticsStudio`
  - Linux: `$XDG_DATA_HOME/BusinessAnalyticsStudio`

  The data folder holds the secrets, the device database, `system-ca.pem` and `instance.json`. Replacing or deleting
  the extracted folder keeps the data.
- A second start with the same data folder opens the running instance instead of starting another one.

Proxy settings can be distributed by IT as `network.json`, placed next to the start file or in the data folder:

```json
{ "proxy": "http://proxy.example.com:8080", "noProxy": ["intranet.example.com", ".corp.example.com"], "systemCa": true }
```

The keys are `proxy`, `pacUrl`, `noProxy` (a string or an array) and `systemCa`. Keys that start with `$` or `_` are
comments. Any other key stops the launch with an error. Variables that are already set override the file.

Launcher options: `--data-dir <path>` (pins the data folder, as `BAS_DEVICE_DIR` does), `--port <n>`, `--no-open`,
`--help`. The same settings are available as `BAS_DATA_DIR` and `BAS_NO_OPEN=1`.

### Releases, download page and customer guide (FR-374, D-48)

- Pushing a tag `v<version>` (equal to `version` in `package.json`) runs `.github/workflows/release.yml`. It type-checks,
  runs the unit tests, builds the six portable zips, writes `SHA256SUMS.txt`, attests build provenance and creates
  the GitHub Release with notes from `.github/release-notes.md`. A manual run builds only and keeps the zips as a
  workflow artifact.
- `site/` is published to GitHub Pages by `.github/workflows/pages.yml` (Settings → Pages → Source: GitHub Actions,
  once). `index.html` reads the latest Release from the GitHub API and recommends the zip for the visitor's PC.
  `guide.md` is the customer guide (Japanese) with screenshots, linked from each zip's `README.txt`.
- `npm run guide:screenshots` retakes `site/images/` from a real zip in `release/`. See `site/README.md`.

## Company news endpoint

`POST /relay/news` accepts a public company name and language, plus an optional public `topic` with
`topicConfirmed: true`. Company names and topics have no separate character cap; the request-body limit and the
provider's URL/query limits still apply.
It uses the same Origin, loopback, Host, JSON-body and per-launch-token checks as the other relay routes.
No Foundry configuration, credentials or C-03 AI approval is required: this is a metadata search, not an AI call.
Only the company-name query, language/region parameters, and a public topic explicitly confirmed by the user go to
Google News RSS; project names, purposes, and other project contents are never sent automatically.
The host and path cannot be supplied by the client, redirects are refused, the timeout is 10 seconds, and responses
are limited to 1 MiB. RSS is validated without DTDs or custom entities; article links must be HTTP(S) without credentials.
Only title, source, publication date and link are returned; article bodies/descriptions are not retrieved or rendered.

The relay caches successful results for five minutes by company, language, and topic (up to 50 entries), coalesces identical
in-flight requests and allows up to 10 distinct concurrent searches. It deduplicates titles/URLs, sorts by publication
date, and returns at most 10 articles with `provider` and `fetchedAt`. Empty search results are successful empty arrays;
malformed feeds are errors, never fabricated articles. Failure codes are `502 newsUnavailable`, `502 invalidNewsFeed`,
`504 newsTimeout`, `429 newsBusy`, `400 invalidNewsRequest`, or `403 outboundNotAllowed`.
The browser retains a previous result only for the same target, marks refresh errors, cancels old requests on target
changes, and stops polling when the live bar is paused. The cache is process-local, not written to disk.
The browser CSP remains same-origin; RSS is fetched by the relay. Static-file-only hosting cannot provide this endpoint.

## Project pack generation (FR-311, D-12)

**Providers.** `POST /relay/ai` takes `provider: "foundry" | "copilotSdk"` (default `foundry`).
For "packBuild" the Foundry call asks for JSON mode (`response_format: json_object`) with `max_completion_tokens`
(required by reasoning deployments); a deployment that rejects that body with HTTP 400 (not billed) is retried once with
the classic `max_tokens` body. The system prompt is the pack builder's: answer with one JSON object from the given
material only.

**Reasoning effort and the output cap (D-44).** Every Foundry application call first sends `reasoning_effort: "medium"`
(`AI_REASONING_EFFORT`). A deployment that rejects it with HTTP 400 (not billed; a content-filter 400 is not retried) is
retried without it, then with the classic `max_tokens` body. Reasoning models spend output tokens on hidden reasoning
before the answer, so the all-step batch caps are 128 000 output tokens (D-45; D-44 had 32 000 and 16 000) for
"deliverableDraft", "solutionDraft", "strategyOverview", "stepBrief", "objectiveDraft" and "packBuild". An answer stopped at the cap (`finish_reason: "length"`)
is `502 outputLimit` with the billed `inputTokens`, `outputTokens` and `reasoningTokens`, never a partial draft; the
browser records those tokens in the ledger as a failed call. GitHub Copilot sessions get the same cap (never above the
model's own `max_output_tokens`) and the same effort when the model lists it (`supportedReasoningEfforts`).
`/relay/ai` also accepts `stage` (`[A-Za-z0-9_:.-]{1,80}`, e.g. `fields-asis:tasks`), written to
`relay-diagnostics.log` with the use, provider, deployment, error, `finishReason`, token counts and answer length —
never the prompt or the answer. Failed Copilot calls are logged the same way.

**Model used by the app: `gpt-6.2-sol` (D-45).** The Microsoft Foundry deployment is named `gpt-6.2-sol` (model
`gpt-6.2-sol` version `2026-11-17`, SKU `GlobalStandard`, capacity 2 000 = the subscription quota, i.e. 2 000 requests
and 2 000 000 tokens per minute). Requirements the app relies on:

- **Context window.** 1 050 000 tokens (up to 922 000 input and 128 000 output). It is a property of the model, not a
  deployment setting, so there is nothing to raise in the portal. The app asks for the full 128 000 output tokens
  (`MODEL_MAX_OUTPUT_TOKENS`, `src/ai/policy.ts`) and accepts prompts up to 200 000 characters (D-41).
- **Chat Completions with `max_completion_tokens`, `reasoning_effort: "medium"` and JSON mode** (`response_format:
  json_object`) are accepted (checked 2026-11-25). The model is a reasoning model, so the retry order above still applies.
- **Price.** Pay-as-you-go: US$2.00 / 1M input, US$10.00 / 1M output, US$0.10 / 1M cached input. A request with more
  than 272 000 input tokens doubles the input rate and multiplies the output rate by 1.5 for the whole request. Capacity
  is a rate limit, not a charge. The output cap is an upper bound only.
- **Access.** Entra ID with "Cognitive Services OpenAI User" (or an API key). The deployment is listed first by the
  connection picker. Create it with `az cognitiveservices account deployment create -g <rg> -n <account>
  --deployment-name gpt-6.2-sol --model-name gpt-6.2-sol --model-version 2026-11-17 --model-format OpenAI --sku-name
  GlobalStandard --sku-capacity <quota>` and save it in **AI settings** (the relay verifies it with a real call).
- **Retirement.** The catalog lists inference retirement on 2027-11-17; `versionUpgradeOption` is
  `OnceNewDefaultVersionAvailable`. Re-check the model before then.

**GitHub Copilot** runs through `@github/copilot-sdk` in the relay process, signed in as the Copilot CLI user on this PC
(`copilot` → `/login`). The relay never sees or stores a GitHub token. Each call creates a session with **no tools**
(`availableTools: []`, every permission request rejected), the system prompt **replaced** by the pack builder's, the
session store off and an empty working directory, and deletes the session afterwards. A cancel that arrives while the session is being created sends nothing. With `BAS_RELAY_OUTBOUND_HOSTS` set, both Copilot routes answer `403 outboundNotAllowed` unless the Copilot hosts are listed. No cost or premium-request figure is calculated or returned. Per-call `assistant.usage` input and output tokens are summed; if any usage event lacks valid counts, or no event arrives, both counts are `null` rather than a fabricated zero. See the [SDK usage documentation](https://github.com/github/copilot-sdk/blob/main/docs/features/usage-and-billing.md).

| Route | Body | Answer |
|---|---|---|
| `POST /relay/copilot/status` | `{}` | `{ available, authenticated, login, models: [{ id, name, multiplier }], settings }` (starts the runtime when needed) |
| `PUT /relay/copilot` | `{ "model": "<id>" }` (`[A-Za-z0-9._:-]{1,64}`, no other field) | `{ copilot: { model } }`, saved in `copilot.json` next to `connection.json` |
| `DELETE /relay/copilot` | — | `{ copilot: null }` |
| `GET /relay/status` | — | also returns `copilot: { model } | null` |

**Official-site reader.** `POST /relay/site` with `{ "url": "<official site>", "terms"?: ["<purpose term>", …] }` returns
`{ pages: [{ url, title, description, themeColor, text, fetchedAt, purposeTerms? }], failed: [{ url, error }] }`. Only
the URL the user typed and links found on that site are requested; nothing from the app is sent. `terms` (the project
name, purpose and focus terms the app extracts on this PC; strings of 2–40 characters, at most 40) never leave the
relay: they only rank the site's own links. Guards: `https` on port 443 only, no credentials and no IP-literal
hosts; **every hostname is resolved and refused when any address is loopback, private, link-local, CGNAT, multicast or
reserved** (`403 privateAddress`); redirects are followed manually (at most 3) and re-checked — the entry page may move
to another public host (a company that changed domains), every other page must stay on that site
(`403 redirectNotAllowed`); every request and every link found on a page is checked again (https, port 443, no credentials, no IP literal); `text/html` only, decoded with the declared charset (header or `<meta charset>`, e.g. Shift_JIS), 1.5 MB and 10 s per page, at most 6 pages (PARAM-145) in 10 attempts.
Pages are chosen best-first: detail pages (outline, sites, figures) before company/profile hubs, then IR, business,
history and sustainability, spreading the pages over sections; tracking parameters are dropped. With `terms`, up to 2
of the 6 pages (`SITE_PURPOSE_PAGES`) go first to links whose anchor text, title, image alt or path names a term,
weighted by rarity (a term found in many of the site's links, such as "ai" on a technology company's site, counts
little); those pages carry `purposeTerms`. When
`BAS_RELAY_OUTBOUND_HOSTS` is set, the site's host must be listed. Errors: `400 invalidUrl`, `403 privateAddress`,
`403 redirectNotAllowed`, `403 outboundNotAllowed`, `502 siteUnavailable` / `notHtml` / `tooLarge`, `504 siteTimeout`.
A DNS answer that changes between the check and the connection is not fully excluded; the relay serves this PC only
(C-01) and the caps bound the impact.
## Work IQ retrieval verification (Microsoft Foundry, or GitHub Copilot by choice)

The Work IQ section is part of the single AI settings dialog (D-25). A refresh token only proves
sign-in, not service enablement, billing assignment or access to Microsoft 365 data. Foundry customer-pack generation
requires the separate retrieval check; ordinary Foundry explanations and GitHub Copilot SDK behavior are unchanged.
The SDK's MCP configuration is not read or modified by BAS.

`POST /relay/workiq/ask` has no per-field character limit on company, project, purpose, focus, business unit or search
topics; selected purpose and focus searches are not truncated. The relay's existing 12,298,924-byte limit applies to
the entire UTF-8 request body (`413 tooLarge` when exceeded). Date, language and time-zone formats and the limit of
eight follow-up topics still apply. The selected AI model and Work IQ service can impose their own input limits;
pack generation separately bounds its AI prompt to 200,000 characters and 100,000 estimated input tokens.
For the Foundry Work IQ route, the tool-call request leaves its output-token limit to the provider so long arguments
can be reproduced; the relay still approves only an exact match. An explicit Foundry context or output-token limit is
reported as `workiqModelLimit`, rather than as an unreadable Work IQ response.

The relay reaches Work IQ in one of three ways, chosen as one radio group in the Work IQ section (FR-366):

| Route | Who signs in | What the tenant must allow | When to use |
| --- | --- | --- | --- |
| **Through Microsoft Foundry** (Work IQ MCP project connection, FR-361) | The Foundry Entra ID sign-in (Foundry holds the user's Work IQ token in a `UserEntraToken` connection whose audience is the Work IQ app ID) | A Work IQ billing policy (Copilot Credits) for the tenant; without it Work IQ answers "The caller tenant does not have a billing policy configured for WorkIQ." | The Foundry connection uses Entra ID and a project of that resource has a Work IQ MCP connection. `POST /relay/workiq/foundry/discover` lists those connections from ARM (projects and connections of the saved resource only, api-version 2025-06-01; nothing is sent to a model or Work IQ). The option is disabled with the reason when the connection is not Entra ID, ARM cannot be read, no usable connection exists, or the last check was refused (`refusedAt` in `workiq-foundry.json`, kept until the route is removed or verified) |
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
The remote `retrieve` tool is missing from some CLI processes (it never appears later in the same process), so the
pack-search session checks `tools/list` first, restarts the CLI up to twice without `retrieve`, and then searches with
the CLI's local `ask` tool instead (one Microsoft 365 Copilot answer per planned search, marked as a Copilot summary,
with the https links it cites as citations; the ladder wordings are skipped because each `ask` takes about a minute).
With `expand`, up to 8 extra searches are built from the project purpose and focus (named things first, then each
purpose sentence) and merged into a `purpose` section. Only these tools are called by the relay:

- `ask` (read-only), only as the fallback described above and for verification when `retrieve` is missing.
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
the CLI exiting early is `502 workiqUnavailable`; the 120-second limit (240 seconds for an `ask` fallback search) is `504 workiqTimeout`. A CLI verification is
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
one accessible OneDrive/SharePoint file with web grounding disabled; the CLI route runs one `retrieve` (or `ask` when
no CLI start offers `retrieve`) for a recent Microsoft 365 item. A nonempty response **with an HTTPS source
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

Work IQ charges are separate from the LLM token summary and are unknown, not zero. BAS cannot enforce a yen-denominated
Work IQ billing cap; check both Azure/Foundry and Copilot Credits charges and configure billing controls/alerts before
enabling paid use.
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
