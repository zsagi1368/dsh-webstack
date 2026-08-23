# dsh-webstack (WebStack / 网栈)

An integrated web **search + fetch kernel plugin** for DeepSeek Harness (DSH). WebStack registers a single neutral aggregator into the host `ctx.web` seam (both the `search` and `fetch` faces) and keeps every routing decision — layer routing (`native` / `free` / `api` / `selfhosted` / `mcp`), query-complexity banding, multi-engine fallback, RRF fusion, caching, credential resolution and the SSRF four-gate safety pipeline — inside itself. The bundled cordis patch is an empty list: coexist mode by default, upstream selectors stay untouched unless you explicitly opt into takeover.

## Features

- **Keyless free pool, works out of the box** — DuckDuckGo HTML endpoint plus a Bing RSS "lite" channel; the `free` layer is structurally credential-free (free-tier engines are forbidden from requiring keys).
- **Hints intent layer** — deterministic regex extraction of `site:` filters, quoted phrases, freshness words and locale from the raw query; hard constraints are pushed down to engines, soft preferences are advisory only.
- **Complexity-banded routing** — queries are banded `simple` / `medium` / `complex` by frozen rules; the band decides how many engines join a search and whether fusion runs.
- **RRF fusion** — multi-engine results are merged with rank-reciprocal scoring (Σ 1/(k+rank), k=60); duplicate URLs keep their first-seen original string while identity normalization happens only inside comparison.
- **Fallback + engine cooldowns** — ordered candidate execution with per-error-class decisions (`retryable` retries once with backoff, `non-retryable` moves on, `terminal` aborts everything); `rate-limited` / `quota` put an engine into cooldown (server `retryAfterMs` respected, defaults 60 s / 300 s).
- **Cache fingerprint + singleFlight** — L0 in-process LRU keyed by a sha256 fingerprint over the full `CacheKeyInput` dimension set (layer, engine set, count, hints, tier, credential fingerprint); concurrent identical searches share one in-flight promise.
- **Three-level credential chain** — legacy literal → host `credentialRef` → env var, resolved once per operation into a snapshot that carries only boolean state, masked hints and opaque hash ids; plaintext never leaves the closure.
- **SSRF four gates** — G1 static check → G2 DNS-resolved-IP classification → G3 per-hop redirect re-validation → G4 bounded body read. Exemptions (`host:port` / IPv4 CIDR) can only skip G2, never G1/G3/G4.
- **Capability degradation ladder** — every optional seam (settings / systemPrompt / tools / credentials / storage) is probed before use; missing capabilities degrade instead of throwing.
- **Doctor diagnostics, bilingual** — `runDoctor` produces a machine-readable report, `renderDoctor` renders zh/en text with per-tier prescriptions.
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

## Configuration

Full key set lives in `src/settings/schema.ts` (`DEFAULT_SETTINGS`). Hot means "the next operation picks it up"; restart means "engine/process structure changes, reload the plugin".

| Key | Default | Hot? | Notes |
| --- | --- | --- | --- |
| `enabled` | `true` | hot | master switch; off = provider reports unavailable, seam falls back |
| `search.layer` | `free` | hot | `native` / `free` / `api` / `selfhosted` / `mcp` |
| `search.autoFallback` | `true` | hot | `false` = first-choice engine only |
| `search.maxResults` | `8` | hot | request-level `maxResults` wins when present |
| `search.fusion.enabled` | `true` | hot | RRF fusion switch |
| `search.fusion.timeDecayHalfLifeH` | `24` | hot | reserved (not yet consumed) |
| `search.fusion.authorityBoost` | `1.0` | hot | reserved (not yet consumed) |
| `search.fusion.diversityDiscount` | `0.85` | hot | reserved (not yet consumed) |
| `search.complexityRouting` | `true` | hot | off = fixed medium-band width |
| `fetch.pipeline` | `t1` | hot | `t1` / `t1+t2` / `t1+t2+t3` |
| `fetch.defaultMode` | `raw` | hot | preferred extract mode (fallback chain may downgrade) |
| `fetch.maxContentChars` | `12000` | hot | rendered budget; canonical derives ×4 capped at 8 MiB |
| `mode.sessionOnline` | `off` | hot | session online mode vocabulary `off/on/ask` |
| `cache.enabled` | `true` | hot | search-result cache |
| `cache.ttlSearchMin` | `10` | hot | search domain TTL |
| `cache.ttlFetchMin` | `60` | hot | fetch domain TTL (domain wiring pending) |
| `cache.persist` | `memory` | hot | L0 memory only today; L1 via `PersistenceAdapter` |
| `safety.ssrfExempts` | `[]` | hot | G2-only exemptions, `host:port` or IPv4 CIDR |
| `engines` | `{}` | **restart** | per-engine `enabled` / `apiKey` / `credentialRef` |
| `mcpServers` | `[]` | **restart** | MCP server list (engines pending) |
| `verticals.packEnabled` | `false` | hot | vertical satellite packs (pending) |
| `advanced.hintsLocale` | `auto` | hot | hints word-list language |

The install-time entry config accepts a flat subset mirroring the above: `enabled`, `layer`, `autoFallback`, `maxResults`, `complexityRouting`, `fusionEnabled`, `maxContentChars`, `ssrfExempts`, `searxngBaseUrl` (selfhosted SearXNG root URL; empty = engine not registered).

## Diagnostics

The host does not currently expose a slash-command registration API to plugins, so WebStack deliberately does not fake `/webstack doctor`. Two equivalent entry points exist:

- Ask the model to call the **`web_backend_status` tool** (auto-registered when the tools seam is present): side-effect-free report of tier mode, per-engine state with cooldown remainder and last error code, and cache hit/miss/size statistics;
- Or simply ask in conversation ("check the WebStack backend status") — the same doctor path runs.

Both are local reads only: no network probes, no credential exposure.

## Pipeline

Text form of one search operation:

```
query
  → extractHints      # site:/quotes/freshness/locale → SearchHints (deterministic)
  → estimateBand      # simple | medium | complex
  → planSearch        # layer pool × band width × autoFallback → engineIds + fusion flag
  → cache             # sha256 fingerprint over CacheKeyInput dims; hit → return as-is
  → creds             # 3-level chain resolved once per op → snapshot + fingerprint
  → fallback          # registry.runWithFallback: cooldown skip, retry-once, terminal abort
  → RRF               # fuseHits dedup by URL identity, Σ1/(60+rank), normalize scores
  → seam              # truncate to count, map NormalizedHit[] → SeamWebSearchResult
```

Fetch operations go through the same outbound channel: budget derivation (canonical = min(maxContentChars×4, 8 MiB)) → SSRF four gates → bounded read → extract fallback chain (raw→fit) → status-as-data reporting.

## Roadmap

- Native delegate handle capture (takeover tier) so the `native` layer forwards to host built-ins.
- `api` (keyed) / `mcp` layer engines.
- Consuming the three fusion tuning params (timeDecayHalfLifeH / authorityBoost / diversityDiscount).
- Fetch-domain cache wiring (`cache.ttlFetchMin` already defined).
- Host locale probing (charter/status sections are fixed Chinese today).
- Runtime read-back verification of `selectorPatchable` / `bridgeOnline`.
- Browser bridge satellite; vertical satellite packs.

## License

[MIT](./LICENSE)
