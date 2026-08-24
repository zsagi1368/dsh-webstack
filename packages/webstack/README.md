# dsh-webstack (WebStack / 网栈)

An integrated web **search + fetch kernel plugin** for DeepSeek Harness (DSH). WebStack registers a single neutral aggregator into the host `ctx.web` seam (both the `search` and `fetch` faces) and keeps every routing decision — layer routing (`native` / `free` / `api` / `selfhosted` / `mcp`), query-complexity banding, multi-engine fallback, RRF fusion, caching, credential resolution and the SSRF four-gate safety pipeline — inside itself. The bundled cordis patch is an empty list: coexist mode by default, upstream selectors stay untouched unless you explicitly opt into takeover.

## Features

- **Keyless free pool, works out of the box** — DuckDuckGo HTML endpoint plus a Bing RSS "lite" channel; the `free` layer is structurally credential-free (free-tier engines are forbidden from requiring keys).
- **Keyed six-engine matrix** — Tavily / Brave / Exa / Jina / Firecrawl / AnySearch are fully wired into the `api` layer candidate pool; a missing key is a structured `auth` failure handed to fallback (never an anonymous downgrade).
- **MCP layer** — each configured `mcpServers` entry passes `validateMcpEntry` (bare `npx` is structurally rejected) and registers as a generic MCP search engine; stdio/http transports, optional SDK peer degrades silently when absent. Ships a static preset catalog (`mcp-presets.ts`) with version-pinned templates.
- **Native delegate tier** — the `native` layer forwards to host built-ins through a delegate engine (handle capture is a platform-side TODO; when absent it fails diagnosably and falls back instead of pretending).
- **Vertical satellite leg (experimental)** — when `verticals.packEnabled && verticals.channels.x`, the plugin lazily imports `dsh-webstack-verticals`: a credential-free, policy-compliant X degradation chain built on free-pool `site:` dual-site search plus official oEmbed enrichment; missing satellites are skipped silently with i18n diagnostic keys.
- **Hints intent layer** — deterministic regex extraction of `site:` filters, quoted phrases, freshness words and locale from the raw query; hard constraints are pushed down to engines, soft preferences are advisory only.
- **Complexity-banded routing** — queries are banded `simple` / `medium` / `complex` by frozen rules; the band decides how many engines join a search and whether fusion runs.
- **RRF fusion with three tunable params** — rank-reciprocal merging (Σ 1/(k+rank), k=60); time-decay half-life / authority boost / same-domain diversity discount are consumed by the ranking; duplicate URLs keep their first-seen original string while identity normalization happens only inside comparison.
- **Fallback + engine cooldowns** — ordered candidate execution with per-error-class decisions (`retryable` retries once with backoff, `non-retryable` moves on, `terminal` aborts everything); `rate-limited` / `quota` put an engine into cooldown (server `retryAfterMs` respected, defaults 60 s / 300 s). Fused legs share a complexity-band budget race (medium 5 s / complex 8 s) with real cancellation.
- **Cache fingerprint + singleFlight + L1 persistence** — L0 in-process LRU keyed by a sha256 fingerprint over the full `CacheKeyInput` dimension set (layer, engine set, count, hints, tier, credential fingerprint). With `cache.persist=durable`, writes go through to the host storage seam (fallback: `~/.webstack/cache` files); disk failures degrade silently to misses.
- **Three-level credential chain** — legacy literal → host `credentialRef` → env var, resolved once per operation into a snapshot that carries only boolean state, masked hints and opaque hash ids; plaintext never leaves the request object's closure.
- **SSRF four gates** — G1 static check → G2 DNS-resolved-IP classification → G3 per-hop redirect re-validation → G4 bounded body read. Exemptions (`host:port` / IPv4 CIDR) can only skip G2, never G1/G3/G4.
- **T3 bridge fallback (optional satellite)** — when the browser bridge satellite is online, a failed static fetch or suspiciously short body (JS-rendered shell) triggers a single `bridge.render(url, 8s)` rescue; results carry `statusCode=0` and `via='bridge'`; `ssrf-blocked` is never bypassed.
- **Session online mode** — host-owned three-state machine (`off/on/ask`); `mode.sessionOnline=on` forces fresh reads that skip the cache (writes still happen), driven by settings and effective immediately.
- **Windows system-proxy fallback** — `advanced.winProxyFallback=true` probes the system proxy early at startup and injects `HTTPS_PROXY`/`HTTP_PROXY` (best-effort layer, off by default).
- **Capability degradation ladder** — every optional seam (settings / systemPrompt / tools / credentials / storage / bridge) is probed before use; missing capabilities degrade instead of throwing.
- **Tool trio** — `web_backend_status` (side-effect-free diagnostics incl. bridge/vertical status lines), `web_batch_search` (≤10 queries fanned out through the same aggregation pipeline, order-preserving, per-item isolation, explicit over-limit rejection), `web_history` (parameterized list/clear replay of the recent search/fetch ring ledger).
- **Doctor diagnostics, bilingual** — `runDoctor` produces a machine-readable report (engine states ∪ unwired config ∪ bridge ∪ vertical tri-state), `renderDoctor` renders zh/en text with per-tier prescriptions.
- **Prompt charter & status sections** — a ≤200-word behavior charter plus a dynamic ≤80-word status line registered into the system prompt seam.

## Install

WebStack is a DSH plugin distributed as the npm package [`dsh-webstack`](https://www.npmjs.com/package/dsh-webstack). Add it through your DSH plugin mechanism (bundle manifest / cordis patch list):

```yaml
# bundle dependency
dependencies:
  - name: dsh-webstack
```

The package ships prebuilt ESM in `lib/`, a cordis patch descriptor at `dsh-webstack/cordis.patch.yml` (empty = coexist mode), and declares the platform packages as peer dependencies:

- required: `@deepseek-ai/cordis`, `@deepseek-ai/dsh-web`
- optional (capability-probed): `@deepseek-ai/dsh-settings`, `@deepseek-ai/dsh-tools`, `@deepseek-ai/dsh-credentials`, `@deepseek-ai/dsh-llm`

Node.js >= 22.19. Zero native modules; runtime dependencies are limited to `@deepseek-ai/schemastery`.

### Satellites

Two optional companion packages live in this monorepo:

- **`dsh-webstack-bridge`** — browser extension providing the T3 render fallback (and JS-shell rescues for static fetching). Installation and pairing instructions: [`packages/bridge/extension/README.md`](../../packages/bridge/extension/README.md).
- **`dsh-webstack-verticals`** — experimental X/Twitter vertical leg (free-pool + oEmbed chain, credential-free). Enable via `verticals.packEnabled` plus `verticals.channels.x`; enabling requires a plugin reload.

## Configuration

Full key set lives in `src/settings/schema.ts` (`DEFAULT_SETTINGS`). Hot means "the next operation picks it up"; restart means "engine/process structure changes, reload the plugin".

| Key | Default | Hot? | Notes |
| --- | --- | --- | --- |
| `enabled` | `true` | hot | master switch; off = provider reports unavailable, seam falls back |
| `search.layer` | `free` | hot | `native` / `free` / `api` / `selfhosted` / `mcp` |
| `search.autoFallback` | `true` | hot | `false` = first-choice engine only |
| `search.maxResults` | `8` | hot | request-level `maxResults` wins when present |
| `search.fusion.enabled` | `true` | hot | RRF fusion switch |
| `search.fusion.timeDecayHalfLifeH` | `24` | hot | freshness half-life in hours; 0 disables decay |
| `search.fusion.authorityBoost` | `1.0` | hot | authority-domain weight multiplier (1 = neutral) |
| `search.fusion.diversityDiscount` | `0.85` | hot | same-domain repetition discount (1 = neutral) |
| `search.complexityRouting` | `true` | hot | off = fixed medium-band width |
| `fetch.pipeline` | `t1` | hot | `t1` / `t1+t2` / `t1+t2+t3` |
| `fetch.defaultMode` | `raw` | hot | preferred extract mode (fallback chain may downgrade) |
| `fetch.maxContentChars` | `12000` | hot | rendered budget; canonical derives ×4 capped at 8 MiB |
| `mode.sessionOnline` | `off` | hot | session online vocabulary `off/on/ask`; `on` forces fresh cache-skipping reads |
| `cache.enabled` | `true` | hot | search-result cache switch |
| `cache.ttlSearchMin` | `10` | hot | search domain TTL (minutes) |
| `cache.ttlFetchMin` | `60` | hot | fetch domain TTL |
| `cache.persist` | `memory` | hot | `durable` enables L1: host storage seam first, file fallback `~/.webstack/cache` |
| `safety.ssrfExempts` | `[]` | hot | G2-only exemptions, `host:port` or IPv4 CIDR |
| `engines` | `{}` | **restart** | per-engine node: `key` (legacy alias `apiKey`) / `credentialRef` / `enabled` |
| `mcpServers` | `[]` | **restart** | MCP server entries; entries passing `validateMcpEntry` register as search engines, rejects surface in the doctor unwired list |
| `verticals.packEnabled` | `false` | hot* | vertical satellite master switch; off applies immediately, on requires a plugin reload (structural registration) |
| `verticals.channels.x` | `false` | hot | X channel switch (bounded by `verticals.packEnabled`; both required for the vertical leg) |
| `verticals.selectorRules` | `[]` | hot | site-specific source rules (`hostSuffix` + CSS selector subset); matched hosts extract via selectors first |
| `advanced.hintsLocale` | `auto` | hot | hints word-list language |
| `advanced.winProxyFallback` | `false` | hot | probe the Windows system proxy early at startup and inject env vars (best-effort layer) |

The install-time entry config accepts a flat subset mirroring the above: `enabled`, `layer`, `autoFallback`, `maxResults`, `complexityRouting`, `fusionEnabled`, `maxContentChars`, `ssrfExempts`, `searxngBaseUrl` (self-hosted SearXNG root URL; empty = engine not registered), `sessionOnline`, `cachePersist`, `winProxyFallback`, `engines`, `mcpServers`, `verticalsPackEnabled`, `verticalsChannelX`.

## Diagnostics

The host does not expose a slash-command registration API to plugins, so WebStack deliberately does not fake `/webstack doctor`. Three equivalent entry points exist:

- Ask the model to call the **`web_backend_status` tool** (auto-registered when the tools seam is present): side-effect-free report of tier mode, per-engine state with cooldown remainder and last error code, bridge/vertical status lines, and cache hit/miss/size statistics;
- **`web_batch_search`**: fan out up to 10 queries through the same aggregation pipeline (credentials/cache/fusion/fallback all identical), order-preserving and per-item isolated;
- **`web_history`**: replay (list) or clear the recent search/fetch ring ledger.

All three only read local state or reuse existing pipelines: no network probes, no credential exposure.

## Settings panel

The client half (`dsh-webstack/client`, built as `lib/client.js`, injected into the Web GUI via ModuleLoader handshake) provides two browser surfaces:

**Settings card (Settings → Plugins, keyed slot `settings.plugin.item`, key `webstack`)**
Editable fields mirror the host settings schema: master switch, default routing layer, max results (1–50), candidate expansion, fusion trio (timeDecayHalfLifeH / authorityBoost / diversityDiscount), fetch char budget, SSRF exemption list (one `host:port` per line). All edits pass through a staged draft state machine (clean / dirty / invalid / saving / failed); writes queue point-by-point after validation. Engine `apiKey`/`credentialRef` are intentionally outside the card — keys never enter the browser render tree.

Degradation ladder:

1. Host exposes a writable `settingsScope` service → drafts are editable and persist to the host settings document;
2. `settingsScope` reachable but read-only (memory mode etc.) → read-only display of effective values;
3. `settingsScope` unreachable (current shape: the dsh-client-ui-settings family is not shipped with plugins) → read-only card against built-in defaults, noting the `webstack:` config-section path.

**Session online button (composer tool row, left end, list slot `conversation.input.left`)**
Session-level three-state cycle off → on → ask (mirrors `mode.sessionOnline`). Click-through persists to the host document when writable; otherwise it degrades to local session state (reset on refresh), noted in the tooltip.

## Pipeline

Text form of one search operation:

```
query
  → extractHints      # site:/quotes/freshness/locale → SearchHints (deterministic)
  → estimateBand      # simple | medium | complex
  → planSearch        # layer pool × band width × autoFallback → engineIds
  │                   # vertical trigger matrix hit → append the vertical leg
  → creds             # 3-level chain resolved once per op → snapshot + fingerprint
  → cache             # sha256 fingerprint over CacheKeyInput dims; mode=on skips reads
  → fallback          # registry.runWithFallback: cooldown skip, retry-once, terminal abort
  ├─ vertical leg     # experimental dsh-webstack-verticals X leg appended after the plan
  → RRF               # fuse dedups by URL identity, Σ1/(60+rank), 3-param weighting
  → seam              # truncate to count, map NormalizedHit[] → SeamWebSearchResult
```

Fetch operations share the outbound channel:

```
url
  → budgets           # canonical = min(maxContentChars×4, 8 MiB); three independent layers
  → SSRF four gates   # G1 static → G2 DNS → G3 per-hop redirect re-validation → G4 bounded body
  → site rules        # selectorRules hit → selector extraction first (mode=fit)
  → extract chain     # raw→fit first non-empty wins; JSON branch pretty-prints
  → report            # status-as-data + never-silently-empty; T3: single bridge.render rescue
```

Budget derivation (canonical = min(maxContentChars×4, 8 MiB)) → SSRF four gates → bounded read → extract fallback chain (raw→fit) → status-as-data reporting; with the bridge satellite online, pipeline failures or short bodies get a single `bridge.render` rescue (`statusCode=0`, `via='bridge'`).

Performance envelopes for every stage are tracked in [`docs/BENCHMARK.md`](./docs/BENCHMARK.md) (reproduce locally with `pnpm --filter dsh-webstack bench`).

## Roadmap

Remaining real TODOs:

- Native delegate handle capture (platform side) so the `native` layer truly forwards to host built-ins.
- Host locale probing (charter/status sections are fixed Chinese today).
- Fetch-domain cache wiring (`cache.ttlFetchMin` already defined).
- Vertical channel expansion and a settings-surface editor for selector rules.
- Runtime read-back verification of `selectorPatchable`; active heartbeat read-back of bridge pairing.
- npm publish automation (release token pending).

## License

[MIT](./LICENSE)
