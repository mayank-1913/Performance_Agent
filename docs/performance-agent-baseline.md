# Performance Agent — Phase 0 Baseline

Captured: 2026-09-15
Scope: read-only inspection. No production behavior was modified.

This document is the reference point for all future incremental enhancements.
Any Phase 1+ change should be evaluated against the current architecture,
data flow, test results, and known limitations recorded here.

---

## 1. Current architecture

Monorepo (npm workspaces, Node >= 18.17):

```
apps/
  api/           Express + better-sqlite3 REST API
  web/           React + Vite + Tailwind SPA
  worker-runner/ Local K6 process runner (embedded into api today; extracted for later moves)
test/fixtures/   Baseline golden fixtures (added in this phase; read-only)
docs/            This document
```

### 1.1 API (`apps/api`)
- Entrypoint: `src/server.js` -> `src/app.js`.
- Routing: `src/routes/index.js` mounts everything under `/api/v1`.
  - Public: `/health`, `/auth`.
  - Protected (JWT via `requireAuth`): `/collections`, `/environments`,
    `/scripts`, `/runs`, `/reports`.
- Middleware: `helmet`, CORS (allow-list from `CORS_ORIGINS`), `compression`,
  JSON/urlencoded body parsers (1 MB), morgan (access logs are suppressed
  for `POST /runs/{prepare,start}` because those endpoints carry manual
  tokens; controllers log their own masked summary instead).
- Persistence: SQLite via `better-sqlite3` at
  `apps/api/storage/database.sqlite`. Schema migrations and admin seeding
  run once on first `getDb()` call. See `src/config/db.js`.
  - DB stores **metadata only**. Raw Postman collections, raw environments,
    generated K6 scripts, K6 metrics/summary, parsed metrics JSON, HTML
    reports, and run logs all live on the filesystem under
    `apps/api/storage/{collections-raw,environments-raw,scripts,run-artifacts,run-logs,reports,uploads}`.
- Auth: JWT (HS256) signed with `JWT_SECRET`. Token extraction supports
  `Authorization: Bearer <token>` and `?token=` (for SSE and HTML report
  downloads). Optional `AUTH_DISABLED=1` bypass injects a synthetic admin
  user (development only).
- Logging: Winston, console + `logs/error.log` + `logs/combined.log`.

### 1.2 Web (`apps/web`)
- React 18 + Vite 5 + Tailwind 3 + `react-router-dom` 6 + `recharts` 2.
- Route-based code splitting; recharts is only pulled in by `RunReport`.
- Feature layout: `features/{auth,collections,scripts,runs,reports,dashboard}`.
- Shared: API client, auth context (JWT + `localStorage`), layout, components.
- Legacy `/upload` and `/environments` routes redirect to `/collections`.

### 1.3 Worker runner (`apps/worker-runner`)
- Packaged as `@perf/worker-runner`, consumed by the API in-process today.
- Modules:
  - `commandBuilder.js` — pure builder for `k6 run [flags] <scriptPath>` args;
    env is passed via the spawn env map, never as positional args (this is
    the fix for the earlier Windows "k6 accepts 1 arg(s), received 3" bug
    caused by spaces in the workspace path).
  - `envInjector.js` — builds the K6 env map, strips `Bearer` prefixes on
    `AUTH_TOKEN`/`JWT_TOKEN`, mirrors `AUTH_TOKEN` into common
    token-shaped keys the collection may reference, masks values for logs.
  - `processManager.js` — resolves the bin path (`where`/`which`), spawns
    with `shell:false`, terminates the tree via `taskkill /T /F` on
    Windows or `SIGTERM/SIGKILL` on POSIX.
  - `streamHandler.js` — redacts token shapes from stdout/stderr, buffers
    lines, exposes a `RingBuffer` per run.
  - `lifecycle.js` — `LifecycleManager` (EventEmitter). Emits `status`,
    `log`, `summary`, `report-ready`.

---

## 2. Current data flow

End-to-end (collection upload -> report):

```
Browser
   │  (POST /collections, multipart 'collection')
   ▼
apps/api/src/middleware/upload.js         (multer disk storage, MIME/ext gate)
   │
   ▼
collections.controller.uploadCollection
   ├── fs.readFile + JSON.parse           (invalid JSON -> 400 + unlink)
   ├── looksLikePostmanV21()              (v2.1 shape gate)
   ├── postman/parser.parse               (walk items -> normalized requests)
   ├── postman/authSanitizer              (strip literal JWTs / Bearer tokens)
   ├── postman/authDetector.detectAuth    (mode: AUTO/ENV/MANUAL/NONE)
   ├── collections.store.add              (SQLite meta + raw JSON on disk)
   └── 201 { id, summary, auth }          (raw collection is never returned)

Environment (optional)
   POST /environments  →  environments.controller.uploadEnvironment
   ├── validateEnvironment                (secret detection, empty-secret warn)
   └── environments.store.add             (SQLite meta + raw JSON on disk)

Tree + auth check
   GET /collections/:id/tree              → sanitized parse → buildTree(...)
   GET|POST /collections/:id/auth-check   → detectAuth against a specific env

Script generation
   POST /scripts/generate
   ├── parse -> sanitizeParsedCollection  (assert no literal tokens escape)
   ├── applySelection(parsed, selection)  (all|requests|folder|single)
   ├── detectAuth on the FILTERED set     (unresolved vars reflect selection)
   ├── buildAuthFlow(parsed)              (login req, capture rules, targets)
   ├── generateK6Script(parsed, ...)      (deterministic emitter)
   ├── assertNoSecretsInScript(code)      (hard guard against JWT/Bearer leaks)
   ├── fs.writeFile storage/scripts/<id>.js
   └── scripts.store.add                  (SQLite meta only)

Run preparation & execution
   POST /runs/prepare   → validate expectedEnvVars, mask, no side effects
   POST /runs/start
   ├── sanitizeManualEnv / normalizeBearer for AUTH_TOKEN / JWT_TOKEN
   ├── detectManualOverrides              (logged as resolver-trace)
   ├── lifecycle.start({ script, env, secrets })
   │    ├── envInjector.buildK6Env        (mirror AUTH_TOKEN into token-shape keys)
   │    ├── processManager.spawnK6        (shell:false; --summary-export & --out json)
   │    ├── streamHandler.attachLineReader (redacted line stream -> ring buffer + log file)
   │    └── emits: status / log / summary / report-ready
   └── 202 { runId, status: 'queued|running' }

Live monitoring
   GET /runs/:runId/stream (SSE): status + log + summary + done
   GET /runs/:runId/logs           snapshot of ring buffer
   GET /runs/:runId                run context (live or persisted)
   POST /runs/:runId/stop          taskkill /T /F on Windows, SIGTERM elsewhere

Metrics + report
   lifecycle.on('report-ready', async ({ runId, paths }) => {
     parseRunArtifacts(summary.json + metrics.json)     // metricsParser.js
       → writeFile parsed-summary.json
     writeReport(parsed, ctx)                            // reportGenerator.js
       → writeFile report.html
     reportsStore.add(manifest)                          // SQLite row
   })

   GET /runs/:runId/{summary,metrics,report}    live or fallback to reportsStore
   GET /reports/                                lists persisted runs
   GET /reports/:id/{metrics,logs,report}       serves parsed JSON / HTML / log
   DELETE /reports/:id                          admin-only; scrubs artifacts dir
```

Auth precedence used across the whole system (documented here as a
non-negotiable contract):

```
1. Manual UI value (__ENV.<KEY>)                       highest — locked override
2. Runtime-extracted token (data.<SLOT> from setup())
3. Collection variable / Postman environment value
4. Empty string                                        request fails loudly
```

---

## 3. Current auth flow

Modules involved:
- `src/lib/postman/authDetector.js` — decides the mode
  (`AUTO_MANAGED` | `ENV_MANAGED` | `MANUAL_REQUIRED` | `NONE`) based on
  collection-level auth, login request detection (POST + URL/name matches
  `login|signin|authenticate|oauth|token`), Bearer headers referencing
  `{{token}}` placeholders, and env-provided token values.
- `src/lib/postman/authSanitizer.js` — the single chokepoint that strips
  literal JWTs and long opaque Bearer/API-key values out of parsed
  collections and replaces them with `{{AUTH_TOKEN}}` / `{{API_KEY}}`
  placeholders. Also exports `assertNoSecretsInScript(code)` which is run
  right before persisting any generated script.
- `src/lib/postman/authFlow.js` — plans the runtime chaining: which JSON
  keys, headers, and cookies to scan on the login response, which
  Postman `pm.environment.set(...)` capture statements to honor, and
  which non-login requests to inject the resolved Authorization header
  into.
- `src/lib/k6/generator.js` — emits the runtime helpers
  (`__resolveAuthHeader`, `__runtimeCookieHeader`, `__hasAnyAuth`) and
  the `setup()` block, plus a name-agnostic token interpolator that
  reroutes any placeholder matching `TOKEN|JWT|AUTH|BEARER` through the
  resolver chain.
- `apps/worker-runner/src/envInjector.js` — at spawn time, mirrors a
  manual `AUTH_TOKEN` into `JWT_TOKEN`, `ACCESS_TOKEN`, `TOKEN`,
  `BEARER_TOKEN`, `ID_TOKEN`, `GLOBAL_AUTH_TOKEN`, and every
  `expectedEnvVar` whose name is token-shaped. Explicit user overrides
  win; SESSION/API_KEY slots are deliberately excluded.
- `apps/api/src/modules/auth/*` — JWT auth for the API itself
  (unrelated to Postman collection auth). Admin/user roles; admin is
  auto-seeded on first boot from `ADMIN_USERNAME`/`ADMIN_PASSWORD`.

---

## 4. Current environment flow

- Upload: `POST /environments` → `environments.controller.uploadEnvironment`
  → `validateEnvironment` (`environments.validator.js`) → store row +
  write raw JSON to `storage/environments-raw/<id>.json`.
- Reads: `environments.store.get(id).raw` lazily reads the raw JSON via a
  cached getter. Raw values are only decrypted in-memory when a caller
  explicitly needs them (auth detection, generation).
- Public views: values matching `SECRET_KEY_RE`
  (`token|jwt|access_token|id_token|bearer|auth|secret|key|password|session`)
  are always masked via `utils/secrets.maskToken`. `hasValue` boolean is
  exposed instead.
- Consumption:
  1. During `POST /scripts/generate`, `environmentRaw` is fed into
     `detectAuth(parsed, environmentRaw)` — its variable names are
     considered a resolution source when deciding whether a token
     placeholder is `resolved` or `unresolved`.
  2. The environment values themselves are **not baked into the K6
     script**. The generator only emits `__ENV.<NAME>` references. The
     values arrive at run time through `env`/`secrets` on the
     `/runs/start` body, or via defaults the user pastes in the UI's
     environment editor.
- Variable interpolation is the same regex everywhere:
  `/\{\{\s*([^}]+?)\s*\}\}/g` (see parser.js, authFlow.js, generator.js,
  authDetector.js). The generator normalizes each placeholder name to an
  env-safe key via `toEnvName()` (snake_upper).

---

## 5. Current K6 generation flow

Entry point: `src/lib/k6/generator.js#generateK6Script(parsed, options)`.

Inputs:
- `parsed` — post-`applySelection`, post-`sanitizeParsedCollection` normalized
  collection (`{ requests, referencedVars, collectionAuth, ... }`).
- `options.injectAuthToken` (bool) — force an `Authorization: Bearer …`
  header on requests that don't declare one.
- `options.loadProfile` — `{ vus, rampUp, hold, rampDown }`, validated
  by `scripts.controller.validateProfile`.
- `options.authFlow` — `buildAuthFlow(parsed)` output. When `enabled`, the
  script emits `RUNTIME_HELPERS` + a `setup()` block; when disabled but
  the script has any `Authorization` header, it emits the smaller
  `ENV_ONLY_HELPERS` so a manual `__ENV.AUTH_TOKEN` still overrides
  everything.

Output shape (deterministic order):
```
1. Header comment (collection name, timestamp, request count, auth flow summary)
2. Imports: `k6/http`, `check, group, sleep`
3. Expected-env-var listing (comment)
4. options { stages, thresholds }
5. RUNTIME_HELPERS or ENV_ONLY_HELPERS (or nothing)
6. setup() (only when runtime auth is enabled)
7. export default function (data) { group('...') { http.<verb>(...) → check → sleep(1) } }
```

Key generator rules:
- Every `Authorization` header — regardless of which placeholder the
  collection uses — is emitted as
  `__resolveAuthHeader(data, `<fallback>`, "<placeholderName>")` (or
  `__resolveAuthHeaderEnv(...)` when runtime is off), never as a bare
  `${__ENV.X}`. This preserves the manual-override precedence.
- Cookie replay: when runtime auth is enabled, requests without a
  `Cookie` header get a spread of `__runtimeCookieHeader(data)`.
- Placeholder interpolation is name-agnostic: any placeholder whose
  normalized name matches `TOKEN|JWT|AUTH|BEARER` is rerouted through
  the manual-override → runtime-slot → captured-var → empty fallback
  chain. `SESSION_ID` and `API_KEY` are separate slots.
- No literal JWT or long opaque Bearer literal is ever allowed in the
  final script: `assertNoSecretsInScript(code)` throws if one is
  detected. This runs before the script is written to disk.

Persistence: `storage/scripts/<uuid>.js` + a SQLite row in `scripts` with
selection, load profile, expected env vars, auth mode, and the auth flow
plan.

---

## 6. Current report generation flow

Trigger: `lifecycle.on('report-ready', ...)` in `runs.manager.js`.

Inputs:
- `summary.json`   — K6 `--summary-export` payload.
- `metrics.json`   — K6 `--out json=` JSONL stream (one `Metric`/`Point`
  event per line).

Processing (`src/lib/k6/metricsParser.js#parseRunArtifacts`):
1. Stream metrics.json line-by-line (up to 10s–100s MB in practice).
   - `Buckets` aggregates VUs, RPS, error count, p95, throughput at a
     configurable interval (default 2s).
   - `RequestAggregator` accumulates per-request stats keyed by
     `tags.name || tags.url || method`.
   - `failuresByKey` retains up to 3 samples per failing endpoint.
2. Read `summary.json` (authoritative for global thresholds + percentiles).
3. Compose the final report:
   - `summary`: startedAt, endedAt, durationMs, iterations, vusMax,
     requests { total, passed, failed, errorRate, rps, throughputBytesPerSec },
     responseTime { avg, min, max, med, p90, p95, p99, count },
     checks { total, passes, fails, passRate }, network, pointsParsed.
   - `thresholds`: `[{ metric, expression, ok, lastValue }]`.
   - `timeseries`: `{ bucketSeconds, points: [{ t, vus, rps, errors, p95, throughput }] }`.
   - `requests`: sorted per-request rows.
   - `failures`: top-N failed endpoints.

Rendering (`src/lib/k6/reportGenerator.js#writeReport`):
- Emits a **single self-contained** HTML file (dark theme, inline CSS,
  vanilla canvas sparklines, no external network).
- Sections: summary stat grid, thresholds table, four charts (p95, RPS,
  errors, VUs), top requests by response time, failures.

Persistence:
- Parsed JSON: `run-artifacts/<runId>/parsed-summary.json`.
- HTML: `run-artifacts/<runId>/report.html`.
- Manifest row: `reports` table (see `db.js` schema); serves the reports
  list, detail page, and post-restart run history.

---

## 7. Existing tests

Command: `npm test` at each workspace root (Node's built-in test runner).

### 7.1 `apps/api/test/`
- `auth.test.js`          JWT roundtrip, `requireAuth` middleware.
- `authFlow.test.js`      Login detection, capture statements, reroute set.
- `authResolver.test.js`  Interpolator & runtime resolver precedence.
- `authSanitizer.test.js` Literal-token detection & placeholder swap.
- `metricsParser.test.js` `parseRunArtifacts` against synthetic JSONL.
- `persistence.test.js`   SQLite init, admin seed, collections raw-on-disk.
- `reportsStore.test.js`  Reports store roundtrip + list ordering + delete.
- `secrets.test.js`       `normalizeBearer`, `formatBearer`, `maskToken`.
- `tree.test.js`          `buildTree`, `resolveSelection`, `applySelection`
  + a generator smoke test asserting single-request selection emits one
  group only.

### 7.2 `apps/worker-runner/test/`
- `commandBuilder.test.js`  Absolute-path assertions, no positional env,
  reporter flag ordering, log preview masking.
- `envInjector.test.js`     Manual-override forwarding, Bearer stripping,
  AUTH_TOKEN mirror rules, expected-env-var mirroring, SESSION exclusion.

---

## 8. Test results

- `apps/api` — `npm test` → **81 pass, 0 fail, 0 skip** in 4.6 s.
- `apps/worker-runner` — `npm test` → **22 pass, 0 fail, 0 skip** in 0.5 s.
- `apps/web` — no test script defined (only `dev`, `build`, `preview`,
  `lint` placeholder).

Total: **103 tests pass, 0 fail.**

---

## 9. Build result

- `apps/web` — `npm run build` (vite build) → **success** in 10.57 s,
  870 modules, produces `dist/` with route-split chunks. Largest chunk:
  `vendor-charts-BTymWSeO.js` at 354.41 kB (recharts).
- `apps/api` — no build step (Node runtime, `type: commonjs`).
- `apps/worker-runner` — no build step.

Additionally, generated K6 scripts on disk under
`apps/api/storage/scripts/` were syntax-checked as ESM (copied to `.mjs`
and run through `node --check`):
- 44 stored scripts total.
- **41 pass** syntax check.
- **3 fail** (see known limitations #1 below). One of the passing scripts
  was additionally validated with `k6 archive`, which succeeded.

k6 binary present on PATH: `k6.exe v1.1.0`.

---

## 10. Known limitations (documented, NOT fixed in this phase)

1. **Single-quote label bug in the "no token available" warning.**
   `generator.js#buildRequestBlock` emits
   `console.warn('[auth] no token available for ${escapeJsonInDouble(label)}')`
   inside single-quoted JS. `escapeJsonInDouble` escapes backslash,
   double quote, CR, and LF — but not the single quote. Any request whose
   folder path or name contains an apostrophe (`User's Carts`, `Bob's
   API`, …) produces a K6 script that Node/k6 refuses to parse.
   - Reproduces on 3 of 44 stored scripts in
     `apps/api/storage/scripts/` (all involve a DummyJSON `1.5 Get User's
     Carts` request).
   - Only triggers when `authFlow.enabled` and the request is an injection
     target (so the `ctx.injectsAuth` branch is taken).
   - Golden fixture: `test/fixtures/baseline/scripts/buggy-apostrophe-label.js`.

2. **`reports/index.json` is a stale, unused artifact.**
   `apps/api/storage/reports/index.json` still holds a JSON manifest from
   before the SQLite migration. `reports.store.js` explicitly does not
   read it, and every new run writes to SQLite instead. It is
   effectively orphaned data — safe to remove in a future cleanup, but
   removing it now would change on-disk state so it stays.

3. **Manual runtime env vs collection variables coexistence is name-based.**
   The AUTH_TOKEN mirror in `envInjector.js` covers well-known
   token-shaped names but relies on `TOKEN_NAME_RE = /TOKEN|JWT|AUTH|BEARER/`
   to auto-mirror onto any expected env var. A collection that uses a
   token-shaped variable name outside that regex (e.g. `{{ticket}}` or
   `{{sso}}`) will not receive the manual mirror unless the user types
   it in explicitly. Same for `SESSION_ID`, which is deliberately not
   mirrored.

4. **`morgan` skips access logs for `/runs/prepare` and `/runs/start`.**
   Controllers log a masked summary, but there is no request-level
   access log entry — intentional to prevent tokens from ending up in
   `combined.log`. Any request-log-based observability tooling must
   fetch these via the app-level info logs instead.

5. **`LifecycleManager` is an in-process singleton.**
   All runs share the API process. Concurrent runs are allowed
   (nothing serializes them), and there is no queue. A crash of the API
   drops the in-memory state; persisted rows only appear after a run's
   `report-ready` handler completes.

6. **K6 script generator has no line-length or output-size guardrails.**
   The 44 stored scripts range up to 84 kB. For very large Postman
   collections, generation time and disk footprint scale linearly with
   the number of requests; there is no chunking.

7. **`applySelection.resolveSelection` for `mode:'folder'` matches on
   folder-name equality.** Two folders with the same name at different
   depths cannot be disambiguated through the API — the UI currently
   only exposes single-level folder selection so this hasn't surfaced.

8. **`env.corsOrigins` defaults to `http://localhost:5173` only.**
   Multi-origin deployments must set `CORS_ORIGINS` explicitly.

9. **JWT_SECRET default is a hard-coded dev string.**
   `env.js` warns in production but does not refuse to boot; production
   deployments must set `JWT_SECRET`.

10. **`.env` is checked into git for `apps/api`.** The `.env.example`
    exists next to it, but the real `.env` is not in `apps/api/.gitignore`
    based on visible listing. Verify before committing further changes
    that no live secrets are inside it.

---

## 11. Files that will likely be modified in future phases

Ranked by likelihood, most-touched first.

| File | Reason |
| --- | --- |
| `apps/api/src/lib/k6/generator.js` | Any change to how tokens, headers, or bodies are emitted; label-escape fix; new K6 features. |
| `apps/api/src/lib/postman/authSanitizer.js` | Broader secret detection (additional header names, longer regexes). |
| `apps/api/src/lib/postman/authFlow.js` | Extra capture rules, new response formats, refresh-token flows. |
| `apps/api/src/lib/postman/authDetector.js` | More auth modes (OAuth2 client credentials, HMAC, etc.). |
| `apps/api/src/lib/k6/metricsParser.js` | New metric aggregations, per-tag breakdowns, larger-scale streaming. |
| `apps/api/src/lib/k6/reportGenerator.js` | Report UX tweaks, additional charts. |
| `apps/api/src/modules/scripts/scripts.controller.js` | New generation options, batch generation, previews. |
| `apps/api/src/modules/runs/runs.manager.js` | Move to out-of-process runner, queue, concurrency limits. |
| `apps/worker-runner/src/envInjector.js` | Expanded AUTH_TOKEN mirror, additional runtime slots. |
| `apps/worker-runner/src/lifecycle.js` | Retry, cancel semantics, multi-run coordination. |
| `apps/api/src/modules/runs/runs.controller.js` | New env/secret validation paths, SSE improvements. |
| `apps/api/src/modules/collections/collections.controller.js` | New collection formats (Postman v2.0, HAR, OpenAPI). |
| `apps/api/src/modules/environments/environments.validator.js` | Broader validation, environment merging. |
| `apps/api/src/config/db.js` | Schema migrations for new fields. |
| `apps/web/src/features/scripts/*` | UI reflecting new generation options. |
| `apps/web/src/features/runs/*` | Live console + metrics enhancements. |
| `apps/web/src/features/reports/*` | New report views. |

The following files are stable contracts and should be treated as
"touch with caution":
- `apps/api/src/routes/index.js` (API contract).
- `apps/api/src/utils/secrets.js` (mask/normalize helpers).
- `apps/worker-runner/src/commandBuilder.js` (Windows-safe spawn).
- `apps/worker-runner/src/processManager.js` (tree kill semantics).

---

## 12. Baseline artifacts

Read-only golden copies of representative script and report outputs are
stored under `test/fixtures/baseline/`. Contents and reproduction rules
are documented in `test/fixtures/baseline/README.md`.
