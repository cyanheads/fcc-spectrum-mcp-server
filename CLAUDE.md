# Developer Protocol

**Server:** fcc-spectrum-mcp-server
**Version:** 0.1.1
**Framework:** [@cyanheads/mcp-ts-core](https://www.npmjs.com/package/@cyanheads/mcp-ts-core) `^0.13.10`
**Engines:** Bun ≥1.4.0, Node ≥24.0.0
**MCP SDK:** `@modelcontextprotocol/server` ^2.1.0
**Zod:** ^4.6.5

> **Read the framework docs first:** `node_modules/@cyanheads/mcp-ts-core/CLAUDE.md` contains the full API reference — builders, Context, error codes, exports, patterns. This file covers server-specific conventions only.

---

## What This Server Is

A keyless FCC radio spectrum licensing server. It indexes the FCC Universal Licensing System (ULS) weekly and daily bulk files into an embedded SQLite index and answers every query from it, with no runtime calls to the FCC. The data is a US government work in the public domain.

**Server-as-source.** The index is built as generation files under `FCC_SPECTRUM_MIRROR_DIR`; `current.json` names the published one and the read path follows it. The first build is an operator step (`mirror:init`, never on startup). Under HTTP the process schedules the weekly rebuild and daily refresh itself (`src/services/uls/ingest-schedule.ts`), each run a child process on the server's runtime executing the compiled `ingest-job.js`, because SQLite calls are synchronous and an ingest step would otherwise block the serving thread for tens of seconds; the server relays the job's log lines and logs a non-zero exit or a kill as the run's failure. Under stdio nothing is spawned; run `mirror:refresh` / `mirror:init` from cron. A cold index (no published generation) fails every tool and resource with the typed `index_not_ready` error, never an empty result. Cursors bind to the generation, so a rebuild invalidates them (`invalid_cursor`).

**Individual-licensee redaction is a first-class, fail-safe feature.** `FCC_SPECTRUM_REDACT_INDIVIDUALS` defaults to on, and only `false`/`0`/`no`/`off` disables it. Redaction happens at read time in one function, `UlsIndexService.redact()`, and individuals are excluded from name search. Contact details (phone, fax, email, ZIP, PO box) are never ingested for anyone. Do not add a read path that bypasses `redact()` or loosens the config parse.

---

## What's Next?

When the user asks what's next or needs direction, suggest options based on the current project state. Common next steps:

1. **Re-run the `setup` skill** — ensures CLAUDE.md, skills, structure, and metadata are populated and up to date with the current codebase
2. **Run the `design-mcp-server` skill** — if the tool/resource surface hasn't been mapped yet, work through domain design
3. **Add tools/resources/prompts** — scaffold new definitions using the `add-tool`, `add-app-tool`, `add-resource`, `add-prompt` skills
4. **Add services** — scaffold domain service integrations using the `add-service` skill
5. **Add tests** — scaffold tests for existing definitions using the `add-test` skill
6. **Field-test definitions** — exercise tools/resources/prompts with real inputs using the `field-test` skill, get a report of issues and pain points
7. **Run `devcheck`** — lint, format, typecheck, and security audit
8. **Run the `security-pass` skill** — audit handlers for MCP-specific security gaps: output injection, scope blast radius, input sinks, tenant isolation
9. **Run the `polish-docs-meta` skill** — finalize README, CHANGELOG, metadata, and agent protocol for shipping
10. **Run the `maintenance` skill** — investigate changelogs, adopt upstream changes, and sync skills after `bun update --latest`

Tailor suggestions to what's actually missing or stale — don't recite the full list every time.

---

## Core Rules

- **Logic throws, framework catches.** Tool/resource handlers are pure — throw on failure, no `try/catch`. Plain `Error` is fine; the framework catches, classifies, and formats. Use error factories (`notFound()`, `validationError()`, etc.) when the error code matters.
- **Use `ctx.log`** for request-scoped logging. No `console` calls.
- **Read the index only through `getUlsIndexService()`** (`src/services/uls/uls-index-service.ts`); no handler opens the SQLite files itself. This server uses no `ctx.state` and never calls `ctx.requestInput`.
- **Secrets in env vars only** — never hardcoded.
- **Cut noise.** Add only what earns its place: no speculative generality, no guards for states the framework already prevents (Zod-validated params, classified errors), no abstraction until a third caller proves it, no option nothing sets.
- **Close the loop on issues.** When implementing work tracked by a GitHub issue, comment on the issue with what landed and close it. Do both — a comment without a close leaves stale issues open; a close without a comment leaves no record of what shipped. The comment is for future readers — state the concrete changes, not the conversation that produced them.

---

## Patterns

All five tools are read-only and declare `openWorldHint: false` (no live network) and typed `errors[]` contracts. Definitions live in `src/mcp-server/tools/definitions/`; shared input schemas (`z.preprocess` normalization, `blankAsUnset`) are in `src/mcp-server/tools/input-schemas.ts` and shared `format()` helpers in `src/mcp-server/tools/format-helpers.ts`.

### Tool

Excerpt of `fcc_spectrum_search_licenses` (`search-licenses.tool.ts`), trimmed:

```ts
import { tool, z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { blankAsUnset, callsignSchema, cursorSchema } from '@/mcp-server/tools/input-schemas.js';
import { getUlsIndexService } from '@/services/uls/uls-index-service.js';

export const searchLicenses = tool('fcc_spectrum_search_licenses', {
  title: 'Search FCC ULS licenses',
  description: 'Search FCC ULS licenses and spectrum leases by callsign, licensee name, …',
  annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
  input: z.object({
    callsign: blankAsUnset(callsignSchema.optional()).describe(
      'Exact callsign or lease ID, e.g. "KNKA123" or "L000012345". Case, spaces, and one trailing portable suffix ("/4") are normalized. …',
    ),
    limit: z.number().int().min(1).max(100).default(25).describe('Records per page (1–100).'),
    cursor: cursorSchema.describe('nextCursor from the previous page of the same search; omit for the first page.'),
    // … licensee, frn, radio_service, status, state
  }),
  output: z.object({
    licenses: z.array(LicenseSchema).describe('Matching records, …'),
    nextCursor: z.string().optional().describe('Pass as cursor with the same filters for the next page; …'),
  }),
  enrichment: {
    dataAsOf: z.string().describe('Creation time of the newest applied ULS file (ISO 8601).'),
    totalCount: z.number().describe('Records matching the filters, across every page.'),
    truncated: z.boolean().describe('True when more records follow this page.'),
    // … shown, cap, appliedFilters, notice
  },
  errors: [
    {
      reason: 'index_not_ready',
      code: JsonRpcErrorCode.ServiceUnavailable,
      when: 'No completed index generation is published yet.',
      retryable: false,
      recovery: 'The local ULS index has not been built yet; call fcc_spectrum_list_reference with topic "coverage" to see its build status. …',
    },
    // … no_criteria, unknown_radio_service, service_not_indexed, invalid_cursor
  ],

  async handler(input, ctx) {
    const index = getUlsIndexService();
    const dataAsOf = await index.dataAsOf();
    if (dataAsOf === undefined) throw ctx.fail('index_not_ready');

    // Enrichment defaults go in first, so a failure or an empty page still carries them.
    ctx.enrich({ dataAsOf, truncated: false, shown: 0, cap: input.limit, appliedFilters });
    ctx.enrich.total(0);
    // … criteria and radio-service checks (`throw ctx.fail('no_criteria')`)

    const page = await index.searchLicenses({ callsign: input.callsign, /* … */ limit: input.limit, cursor: input.cursor });
    if (!page.ok) throw ctx.fail('invalid_cursor');

    ctx.enrich.total(page.total);
    ctx.enrich({ shown: page.rows.length });
    if (page.nextCursor) {
      ctx.enrich.truncated({ shown: page.rows.length, cap: input.limit, guidance: fragments.join(' ') });
    } else if (fragments.length) {
      ctx.enrich.notice(fragments.join(' '));
    }
    return { licenses: page.rows, ...(page.nextCursor && { nextCursor: page.nextCursor }) };
  },

  // format() populates content[] — the markdown twin of structuredContent. Both must carry
  // the same data; the linter enforces that every `output` field appears in the rendered text.
  format: (result) => {
    const lines: string[] = [`## FCC ULS licenses (${result.licenses.length} on this page)`];
    // … one block per license: licensee, status, service, dates, counts
    if (result.nextCursor) lines.push('', `**nextCursor:** ${result.nextCursor}`);
    return [{ type: 'text', text: lines.join('\n') }];
  },
});
```

Every tool opens the same way: `dataAsOf()` for readiness, then enrichment defaults written unconditionally before any validation that can throw. Text-valued inputs are normalized inside a `z.preprocess` (callsign case and portable suffix, FRN padding, state names, frequency units), so the advertised pattern holds for the normalized value and handlers only see canonical input.

### Resource

`fcc-spectrum://license/{callsign}` (`license.resource.ts`), trimmed. It returns the first page `fcc_spectrum_get_license` returns, as JSON:

```ts
export const licenseResource = resource('fcc-spectrum://license/{callsign}', {
  name: 'fcc_spectrum_license',
  title: 'FCC ULS license by callsign',
  description: `One FCC ULS license or spectrum lease by callsign, as JSON: …`,
  mimeType: 'application/json',
  params: z.object({
    callsign: z.preprocess(percentDecoded, callsignSchema).describe('Callsign or lease ID, e.g. KNKA123 or L000012345, percent-encoded; …'),
  }),
  cacheHint: { ttlMs: 3_600_000, cacheScope: 'public' },
  errors: [
    { reason: 'index_not_ready', code: JsonRpcErrorCode.ServiceUnavailable, retryable: false, /* … */ },
    { reason: 'license_not_found', code: JsonRpcErrorCode.NotFound, when: 'No indexed record carries the callsign.', /* … */ },
  ],

  async handler(params, ctx) {
    const index = getUlsIndexService();
    const dataAsOf = await index.dataAsOf();
    if (dataAsOf === undefined) throw ctx.fail('index_not_ready');

    const result = await index.getLicense({ callsign: params.callsign, maxFrequencies: MAX_FREQUENCIES });
    if (!result.found) throw ctx.fail('license_not_found', `No record with callsign ${params.callsign} in the indexed service groups.`, { callsign: params.callsign, /* candidates */ });
    // … build the page and a `notice` naming the fcc_spectrum_get_license call for the rest
    return { dataAsOf, license: result.license, locations: result.locations, /* … */ };
  },
});
```

### Prompt

This server has no prompts (`prompts: []` in `createApp()`). It is a lookup/search/decode surface with no recurring multi-step interaction worth templating.

### Server config

`src/config/server-config.ts`, trimmed. Lazy-parsed, separate from framework config:

```ts
import { z } from '@cyanheads/mcp-ts-core';
import { parseEnvConfig } from '@cyanheads/mcp-ts-core/config';

/** Only an explicit off-word disables redaction; anything else — typos included — keeps it on. */
const REDACTION_OFF = new Set(['false', '0', 'no', 'off']);

const ServerConfigSchema = z.object({
  mirrorDir: z.string().default('.mirror/fcc-uls').transform((dir) => resolve(dir)).describe('Directory for index generations, current.json, the ingest lock, and temp zips'),
  services: z.string().default(DEFAULT_SERVICE_GROUPS.join(',')).transform(/* validate and order the groups */).describe('Weekly service groups to index'),
  redactIndividuals: z
    .string()
    .optional()
    .transform((value) => !REDACTION_OFF.has(value?.trim().toLowerCase() ?? ''))
    .describe('Redact individual licensees; fail-safe (only false/0/no/off disables)'),
  baseUrl: z.url().default('https://data.fcc.gov/download/pub/uls').transform((url) => url.replace(/\/+$/, '')).describe('ULS bulk host root'),
});

let _config: ServerConfig | undefined;
export function getServerConfig(): ServerConfig {
  _config ??= parseEnvConfig(ServerConfigSchema, {
    mirrorDir: 'FCC_SPECTRUM_MIRROR_DIR',
    services: 'FCC_SPECTRUM_SERVICES',
    redactIndividuals: 'FCC_SPECTRUM_REDACT_INDIVIDUALS',
    baseUrl: 'FCC_SPECTRUM_BASE_URL',
  });
  return _config;
}
```

`parseEnvConfig` maps Zod schema paths → env var names so errors name the variable (`FCC_SPECTRUM_SERVICES`) not the path (`services`). Throws `ConfigurationError`, which the framework prints as a clean startup banner. `redactIndividuals` is a privacy control and parses as a string with an explicit off-list rather than `z.stringbool()`, so a typo or an unset variable keeps redaction on instead of throwing or disabling it.

For other env booleans use `z.stringbool()`, never `z.coerce.boolean()` — `Boolean("false")` is `true`, so a coerced flag can't be disabled through the environment.

### Server identity, session posture, and lifecycle

`src/index.ts`, trimmed:

```ts
await createApp({
  name: 'fcc-spectrum-mcp-server',   // machine name on every surface — never Title Case
  title: 'fcc-spectrum-mcp-server',  // display identity = the hyphenated repo name
  tools: allToolDefinitions,
  resources: allResourceDefinitions,
  prompts: [],
  instructions: `FCC radio spectrum licensing from the Universal Licensing System (ULS), served from a local index … ${getServerConfig().redactIndividuals ? REDACTION_SENTENCE : ''} … Data: FCC Universal Licensing System, a US government work in the public domain.`,
  // No tool asks the caller for input mid-call; MCP_SESSION_MODE still overrides this.
  sessionMode: 'stateless',
  async setup(core) {
    const { baseUrl, mirrorDir, redactIndividuals, services } = getServerConfig();
    initUlsIndexService({ mirrorDir, redactIndividuals, services });
    // A long-lived HTTP process owns the ingest cron; stdio operators run mirror:* from cron.
    if (core.config.mcpTransportType === 'http') {
      await startIngestSchedule({ baseUrl, mirrorDir, services });
    }
  },
  async teardown() {
    // Jobs go first: a job in flight writes to the index the service is about to close.
    await stopIngestSchedule();
    await getUlsIndexService().close();
  },
});
```

`name` and `title` are both the hyphenated machine name; `description` is not passed (it derives from `package.json`). `instructions` is session-level orientation sent on every `initialize`: here it names the source, the tool workflow, the status semantics, and (when redaction is on) the redaction rule. `src/index.ts` loads `./.env` itself because `instructions` reads the redaction setting before `createApp()` runs.

`sessionMode: 'stateless'` declares the HTTP session posture in `src/`; `MCP_SESSION_MODE` still wins whenever it carries a meaningful value. Stateless is correct here: every tool is a single-shot read over the local index. Do not add `require: 'stateful'`. `.env.example`, the `Dockerfile`, and the README env table carry `stateless` and must stay in step.

`teardown` runs after the transport stops and before the logger closes, on every shutdown path. It awaits `stopIngestSchedule()` before closing the index, because a job in flight writes to the index the service is about to close: the stop sends a running job process SIGTERM, on which it persists its progress and releases the lock, then SIGKILL after 5 s, inside the framework's 10 s shutdown ceiling. A killed job's rebuild resumes from its last completed step at the next run.

---

## Context

Handlers receive a unified `ctx` object. Key properties:

| Property | Description |
|:---------|:------------|
| `ctx.log` | Request-scoped logger — `.debug()`, `.info()`, `.notice()`, `.warning()`, `.error()`. Auto-correlates requestId, traceId, tenantId. Dual-sink: Pino **and** `notifications/message` to the client, so treat it as client-visible. |
| `ctx.fail` | Throw a typed contract error by `reason`, declared in the definition's `errors[]` (every tool and the resource). |
| `ctx.enrich` | Success-path agent context — `ctx.enrich({ … })` for the declared `enrichment` fields, plus `.total(n)`, `.truncated({ shown, cap, guidance })`, and `.notice(text)`. Reaches `structuredContent` and `content[]`; lands only when the definition declares an `enrichment` block. |
| `ctx.requestId` | Request ID — the one every log record of the call carries and its error envelope returns as `data.requestId`. |

This server is read-only over the local index: no `ctx.state` (the index is the store), no `ctx.requestInput` / `ctx.inputs`, no `ctx.content`.

---

## Errors

Handlers throw — the framework catches, classifies, and formats.

**Recommended: typed error contract.** Declare `errors: [{ reason, code, when, recovery, retryable?, severity?, thrownBy? }]` on `tool()` / `resource()` to receive `ctx.fail(reason, …)` typed against the reason union. TypeScript catches typos at compile time, `data.reason` is auto-populated for observability, linter enforces conformance against the handler body. `recovery` is required (≥ 5 words, lint-validated) — the single source of truth for the agent's next move. The framework puts it on the wire whenever a failure carrying that `reason` arrives without a hint — a bare `ctx.fail('reason')` or a service throw with `data: { reason }` — as `data.recovery.hint`, mirrored into `content[]` text unless the message already contains it verbatim; override with an explicit `{ recovery: { hint: '...' } }` when dynamic runtime context matters. Every error envelope also carries `data.requestId`, the id the server's log records for that call carry, and `content[]` closes with `(reason … · request <id>)`. Mark an entry the service layer throws with `thrownBy: 'service'` so `error-contract-unthrown` skips it — lint-only metadata, nothing at runtime reads it. Baseline codes (`InternalError`, `ServiceUnavailable`, `Timeout`, `ValidationError`, `SerializationError`, `RequestCancelled`) bubble freely and don't need declaring.

```ts
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';

errors: [
  { reason: 'index_not_ready', code: JsonRpcErrorCode.ServiceUnavailable,
    when: 'No completed index generation is published yet.',
    retryable: false,
    recovery: 'The local ULS index has not been built yet; call fcc_spectrum_list_reference with topic "coverage" to see its build status. An operator must run the mirror:init script once before searches work.' },
],
async handler(input, ctx) {
  const dataAsOf = await getUlsIndexService().dataAsOf();
  if (dataAsOf === undefined) throw ctx.fail('index_not_ready');
  // …
}
```

**Declare contracts inline on each tool.** The contract is part of the tool's public surface — one file should give the full picture. Don't extract a shared `errors[]` constant; per-tool repetition is the intended cost of locality.

**Fallback (no contract entry fits):** throw via factories or plain `Error`.

```ts
// Error factories — explicit code
import { notFound, serviceUnavailable } from '@cyanheads/mcp-ts-core/errors';
throw notFound('Item not found', { itemId });
throw serviceUnavailable('API unavailable', { url }, { cause: err });

// Plain Error — framework auto-classifies from message patterns
throw new Error('Item not found');           // → NotFound
throw new Error('Invalid query format');     // → ValidationError

// McpError — when no factory exists for the code
import { McpError, JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
throw new McpError(JsonRpcErrorCode.InitializationFailed, 'Connection failed', { pool: 'primary' });
```

See framework CLAUDE.md and the `api-errors` skill for the full auto-classification table, all available factories, and the contract reference.

---

## Structure

```text
src/
  index.ts                              # createApp() entry; identity, sessionMode, setup/teardown wiring
  config/
    server-config.ts                    # FCC_SPECTRUM_* env vars (Zod schema)
  services/uls/
    uls-index-service.ts                # read path over the published generation; the redact() chokepoint
    types.ts                            # read-model types the tools return
    ingest.ts                           # UlsIngester: weekly rebuild + daily refresh into generation files
    ingest-schedule.ts                  # HTTP-only cron: Sunday rebuild, daily refresh, each a child process
    ingest-job.ts                       # the scheduled job the child runs (compiled entry); log lines as JSON on stdout
    bulk-client.ts                      # paced HTTP client for the ULS bulk host
    zip-reader.ts  dat.ts               # streaming ZIP reader; .dat record parsing
    schema.ts                           # store spec, generation naming, current.json pointer, ingest lock
    codes.ts                            # service groups and bundled code tables
    normalize.ts                        # callsign / FRN / state / status / unit / DMS normalizers
    organization-names.ts               # organization words for the blank/H applicant-type individual rule
    state-lookup.ts  data/us-states.json # point-in-polygon state derivation
    market-states.ts  data/market-states.json # FCC market area → states, for the market state filter
  mcp-server/
    tools/
      input-schemas.ts                  # shared z.preprocess input schemas, blankAsUnset
      format-helpers.ts                 # shared format() helpers
      definitions/
        search-licenses.tool.ts         # fcc_spectrum_search_licenses
        get-license.tool.ts             # fcc_spectrum_get_license
        find-transmitters.tool.ts       # fcc_spectrum_find_transmitters
        search-frequencies.tool.ts      # fcc_spectrum_search_frequencies
        list-reference.tool.ts          # fcc_spectrum_list_reference
    resources/definitions/
      license.resource.ts               # fcc-spectrum://license/{callsign}
scripts/
  fcc-mirror-init.ts                    # mirror:init — weekly rebuild, out-of-band
  fcc-mirror-refresh.ts                 # mirror:refresh — daily refresh
  fcc-mirror-verify.ts                  # mirror:verify — integrity and count check
  _mirror-context.ts                    # shared setup for the three mirror scripts
  build-state-boundaries.ts             # regenerate us-states.json (run by hand)
  build-market-states.ts                # regenerate market-states.json from FCC sources (run by hand; --check)
```

---

## Naming

| What | Convention | Example |
|:-----|:-----------|:--------|
| Files | kebab-case with suffix | `search-docs.tool.ts` |
| Tool/resource/prompt names | snake_case | `search_docs` |
| Directories | kebab-case | `src/services/doc-search/` |
| Descriptions | Single string or template literal, no `+` concatenation | `'Search items by query and filter.'` |

---

## Skills

Skills are modular instructions in `framework-skills/` at the project root. Read them directly when a task matches — e.g., `framework-skills/add-tool/SKILL.md` when adding a tool. `bun run list-skills` prints the full registry. The directory is deliberately not `skills/`: Claude Code and Codex auto-load a plugin's root `skills/`, so a server that ships `.claude-plugin/` or `.codex-plugin/` would hand these development skills to every agent that installs it. Keep `skills/` free for skills meant for those agents.

**Agent skill directory:** Copy skills into the directory your agent discovers (Claude Code: `.claude/skills/`, others: equivalent). Skills then load as context without referencing `framework-skills/` paths. After framework updates, run the `maintenance` skill — Phase B re-syncs the agent directory.

Available skills:

| Skill | Purpose |
|:------|:--------|
| `setup` | Post-init project orientation |
| `design-mcp-server` | Design tool surface, resources, and services for a new server |
| `add-tool` | Scaffold a new tool definition |
| `add-app-tool` | Scaffold an MCP App tool + paired UI resource |
| `add-resource` | Scaffold a new resource definition |
| `add-prompt` | Scaffold a new prompt definition |
| `add-service` | Scaffold a new service integration |
| `add-test` | Scaffold test file for a tool, resource, or service |
| `field-test` | Exercise tools/resources/prompts with real inputs, verify behavior, report issues |
| `tool-defs-analysis` | Read-only audit of MCP definition language across the surface — voice, leaks, defaults, recovery hints, output descriptions |
| `security-pass` | Audit server for MCP-flavored security gaps: output injection, scope blast radius, input sinks, tenant isolation |
| `code-simplifier` | Post-session cleanup against `git diff` — modernize syntax, consolidate duplication, align with the codebase |
| `polish-docs-meta` | Finalize docs, README, metadata, and agent protocol for shipping |
| `git-wrapup` | Land working-tree changes as a commit stack — version bump, changelog, verify, commit by concern, release commit on top. No tag, no push to main; opens the release PR when the project declares release PR mode |
| `release-pr-review` | Review pass on an open release PR — simplifier + correctness review, fixes as ordinary commits on top of the stack, PR body kept in sync. Release PR mode only |
| `release-and-publish` | Fast-forward merge (release PR mode) + tag + push + npm + MCP Registry + GH Release + Docker. Picks up from `git-wrapup` |
| `maintenance` | Investigate changelogs, adopt upstream changes, sync skills to agent dirs |
| `orchestrations` | Chain task skills into a gated multi-phase pipeline — build-out, QA-fix, update-ship — when you can spawn sub-agents |
| `report-issue-framework` | File a bug or feature request against `@cyanheads/mcp-ts-core` via `gh` CLI |
| `report-issue-local` | File a bug or feature request against this server's own repo via `gh` CLI |
| `techniques` | Catalog of response/data-shaping techniques — overflow handling, payload shaping, retrieval patterns |
| `api-auth` | Auth modes, scopes, JWT/OAuth |
| `api-canvas` | DataCanvas: register tabular data, run SQL, export, plus the `spillover()` helper for big result sets — Tier 3 opt-in |
| `api-config` | AppConfig, parseConfig, env vars |
| `api-context` | Context interface, RequestContext, logger, state, multi-round-trip input |
| `api-errors` | McpError, JsonRpcErrorCode, error patterns |
| `api-linter` | Definition linter rule catalog — invoked by `bun run lint:mcp` and `devcheck` |
| `api-mirror` | MirrorService: persistent self-refreshing local mirror (embedded SQLite + FTS5) of a bulk upstream dataset — Tier 3 opt-in |
| `api-services` | LLM, Speech, Graph services |
| `api-testing` | createMockContext, test patterns |
| `api-utils` | Formatting, parsing, security, pagination, scheduling, telemetry helpers |
| `api-telemetry` | OTel catalog: spans, metrics, completion logs, env config, cardinality rules |
| `api-workers` | Cloudflare Workers runtime |

**Chaining skills into pipelines.** When the user wants a multi-phase effort — build this server out, QA-and-fix the surface, update-and-ship — *and you can spawn sub-agents*, `framework-skills/orchestrations/SKILL.md` sequences the task skills above into a gated pipeline with verification at each step. Read it to drive the run. Optional: skip it if you can't orchestrate sub-agents, and ignore it entirely if you were *spawned* as one — you've already been scoped to a single phase.

When you complete a skill's checklist, check the boxes and add a completion timestamp at the end (e.g., `Completed: 2026-03-11`).

---

## Commands

**Runtime:** Scripts use Bun's native TypeScript execution — `bun run <cmd>` is the standard invocation. `npm run <cmd>` also works (npm delegates to bun).

| Command | Purpose |
|:--------|:--------|
| `bun run build` | Compile TypeScript |
| `bun run rebuild` | Clean + build |
| `bun run clean` | Remove build artifacts |
| `bun run devcheck` | Lint + format + typecheck + security + changelog sync |
| `bun run audit:fix` | `bun audit fix` — upgrade vulnerable packages to the lowest safe version within existing ranges (`--dry-run` previews, `--latest` rewrites ranges). First response when `devcheck` flags a transitive advisory; then `bun update <name>`, then `bun dedupe` |
| `bun run audit:refresh` | Delete `bun.lock` and reinstall. Last resort after `audit:fix`, `bun update <name>`, and `bun dedupe` — re-resolves every ranged dep (the framework pin included) and rewrites the lockfile as `lockfileVersion: 2` |
| `bun run lint:mcp` | Run the MCP definition linter standalone (rule catalog: `api-linter` skill) |
| `bun run lint:packaging` | Packaging surface checks — `server.json`/`manifest.json` env-var parity (run by devcheck) |
| `bun run mirror:init` | Weekly rebuild of the ULS index into a new generation (skips when the published one already holds every selected group). The one-time operator step |
| `bun run mirror:refresh` | Apply daily files newer than the index checkpoint (stdio deployments run it from cron) |
| `bun run mirror:verify` | SQLite integrity check plus per-snapshot line-count comparison of the published index |
| `bun run release:github` | Publish the GitHub Release (`.mcpb` bundle) — a `release-and-publish` step |
| `bun run publish-mcp` | Publish to the MCP Registry — a `release-and-publish` step |
| `bun run list-skills` | Print the skill registry |
| `bun run tree` | Generate directory structure doc |
| `bun run format` | Auto-fix formatting (safe fixes only) |
| `bun run format:unsafe` | Also apply Biome's unsafe autofixes — review the diff; they can change behavior |
| `bun run test` | Run tests (Vitest — use `bun run test`, not `bun test`) |
| `bun run test:coverage` | Tests with a coverage report |
| `bun run start:stdio` | Production mode (stdio) |
| `bun run start:http` | Production mode (HTTP) |
| `bun run changelog:build` | Regenerate `CHANGELOG.md` from `changelog/*.md` |
| `bun run changelog:check` | Verify `CHANGELOG.md` is in sync (used by devcheck) |
| `bun run bundle` | Build, pack, and clean a `.mcpb` for one-click Claude Desktop install |

**CI is one file.** `.github/workflows/codeql.yml` (scaffolded) is the only GitHub Actions workflow: CodeQL is GitHub-owned end to end, and the file runs only while the repo's CodeQL *default setup* is turned off. Verification — `devcheck`, tests, the release gates — runs locally; don't add a workflow that re-runs it.

---

## Bundling

`npm run bundle` produces a `.mcpb` extension bundle for one-click install in Claude Desktop. The pack step is followed by `scripts/clean-mcpb.ts`, which prunes dev dependencies (`mcpb clean`) and strips two classes of `node_modules/**` content that root-anchored `.mcpbignore` patterns cannot reach: dependency-shipped agent docs (`framework-skills/`, `skills/`, `.claude/`, `.agents/`, `SKILL.md`) and platform-specific native bindings, which would otherwise lock the bundle to the platform it was packed on. A server using DataCanvas therefore ships a portable bundle without the DuckDB native — `@duckdb/node-api` is an optional peer loaded lazily, so canvas tools report an actionable install hint and every other tool works normally. MCPB is stdio-only — HTTP and Cloudflare Workers deployments are unaffected. Consumers who don't need it can delete `manifest.json` and `.mcpbignore`; `lint:packaging` skips cleanly.

**Adding an env var requires both files:** `server.json` (registry discovery, `environmentVariables[]`) and `manifest.json` (bundle install UX, `mcp_config.env` + `user_config`). `lint:packaging` (run by `devcheck`) verifies the env var names match, that every `user_config` option is wired into `mcp_config.env` as `"X": "${user_config.X}"` (the host substitutes nothing else — `"${X}"` reaches the server as that literal string), and that an optional string option carries `"default": ""`.

**README install badges** (Claude Desktop `.mcpb`, Cursor, VS Code) and the `base64` / `encodeURIComponent` config-generation commands are ship-time concerns — run the `polish-docs-meta` skill, which carries the badge format, layout, and generation snippets in `framework-skills/polish-docs-meta/references/readme.md`.

---

## Changelog

Directory-based, grouped by minor series via the `.x` semver-wildcard convention. Source of truth: `changelog/<major.minor>.x/<version>.md` (e.g. `changelog/0.1.x/0.1.0.md`) — one file per release, shipped in the npm package. At release, author the per-version file with a concrete version and date, then run `npm run changelog:build` to regenerate the rollup. `changelog/template.md` is a **pristine format reference** — never edited or moved; read it for the frontmatter + section layout when scaffolding. `CHANGELOG.md` is a **navigation index** (header + link + summary per version), regenerated by `npm run changelog:build` — devcheck hard-fails on drift; never hand-edit it.

Each per-version file opens with YAML frontmatter:

```markdown
---
summary: "One-line headline, ≤350 chars"  # required — powers the rollup index
breaking: false                            # optional — true flags breaking changes
security: false                            # optional — true ONLY for a source-code security fix, never a dependency CVE bump
---

# 0.1.0 — YYYY-MM-DD
...
```

`breaking: true` renders a `· ⚠️ Breaking` badge — use it when consumers must update code on upgrade (signature changes, removed APIs, config renames). `security: true` renders a `· 🛡️ Security` badge and pairs with a `## Security` body section — set it only for a security fix in this server's *own source code*, never for a routine dependency or transitive CVE bump (record those under `## Dependencies`). When both are set, badges render `· ⚠️ Breaking · 🛡️ Security`.

`agent-notes` is an optional free-form field for maintenance agents processing the release downstream. Content here won't appear in the rendered CHANGELOG — it's consumed by agents running the `maintenance` skill. Use it for adoption instructions that don't fit the human-facing sections: new files to create, fields to populate, one-time migration steps. Omit entirely when there's nothing to say.

**Section order:** the Keep a Changelog sequence — Added, Changed, Deprecated, Removed, Fixed, Security — then `Dependencies` last. Include only sections with entries — don't ship empty headers.

**Tag annotations** render as GitHub Release bodies via `--notes-from-tag`. They must be structured markdown — never a flat comma-separated string. Subject omits the version number (GitHub prepends it). See `changelog/template.md` for the full format reference.

---

## Publishing

**Every release goes through a release PR, straight-through** — `git-wrapup`'s "Release PR mode", mode `straight-through`. One run: `git-wrapup` lands the commit stack on `release/<version>`, pushes it, and opens the PR (title = the release commit subject, body = the changelog entry plus a gates section); `release-and-publish` then fast-forwards `main` locally with `git merge --ff-only`, creates the tag on `main`'s tip, pushes `main` and the tag, deletes the branch, and publishes. A caller's brief may run a given release as `gated` instead — a `release-pr-review` pass on the open PR before `release-and-publish`. **Never merge through the GitHub UI or `gh pr merge`**: squash and rebase-merge are disabled in the repo settings because both rewrite the stack (rebase-merge also strips the SSH signatures), and a merge commit breaks the linear history.

---

## Imports

```ts
// Framework — z is re-exported, no separate zod import needed
import { tool, z } from '@cyanheads/mcp-ts-core';
import { McpError, JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';

// Server's own code — via path alias
import { getMyService } from '@/services/my-domain/my-service.js';
```

---

## Checklist

- [ ] Zod schemas: all fields have `.describe()`, only JSON-Schema-serializable types (no `z.custom()`, `z.date()`, `z.transform()`, `z.bigint()`, `z.symbol()`, `z.void()`, `z.map()`, `z.set()`, `z.function()`, `z.nan()`)
- [ ] Optional nested objects: handler guards for empty inner values from form-based clients (`if (input.obj?.field && ...)`, not just `if (input.obj)`). When regex/length constraints matter, use `z.union([z.literal(''), z.string().regex(...).describe(...)])` — literal variants are exempt from `describe-on-fields`.
- [ ] JSDoc `@fileoverview` + `@module` on every file
- [ ] `ctx.log` for logging; index reads only through `getUlsIndexService()`
- [ ] Handlers throw on failure — `ctx.fail(reason)` against the declared `errors[]`, no try/catch
- [ ] Every handler gates on `dataAsOf()` first and throws `index_not_ready` on a cold index, and writes its `ctx.enrich` defaults unconditionally before any validation that can throw
- [ ] Text inputs normalize inside `z.preprocess` (via `input-schemas.ts`), so the advertised pattern holds for the normalized value; optional fields wrap in `blankAsUnset`
- [ ] Any new output carrying a licensee, address, or trustee name reads it through the `UlsIndexService.redact()` chokepoint; contact fields stay un-ingested
- [ ] `format()` renders all data the LLM needs — different clients forward different surfaces (Claude Code → `structuredContent`, Claude Desktop → `content[]`); both must carry the same data
- [ ] If wrapping external API: raw/domain/output schemas reviewed against real upstream sparsity/nullability before finalizing required vs optional fields
- [ ] If wrapping external API: normalization and `format()` preserve uncertainty; do not fabricate facts from missing upstream data
- [ ] If wrapping external API: tests include at least one sparse payload case with omitted upstream fields
- [ ] Registered in `createApp()` arrays (directly or via barrel exports)
- [ ] Tests use `createMockContext()` from `@cyanheads/mcp-ts-core/testing`
- [ ] `.codex-plugin/plugin.json` populated — `name`, `version`, `description`, `repository`, `license` from `package.json`; `interface.displayName` = the unscoped repo name (never the npm scope — `lint:packaging` enforces this); `interface.shortDescription` from `package.json` description
- [ ] `.codex-plugin/mcp.json` updated — server name key is the unscoped repo name; every user-supplied variable (API key, contact email, instance URL) is listed in `env_vars` so Codex forwards it from the user's environment. Never write `"KEY": ""` into `env` — an empty value replaces the user's exported key and is read as unset
- [ ] `.claude-plugin/plugin.json` populated — `name`, `version`, `description`, `author`, `repository`, `license`, `keywords` from `package.json`; inline `mcpServers` entry keyed by the unscoped repo name. Every user-supplied variable is declared under `userConfig` (`type`, `title`, `description`; `sensitive: true` for keys and tokens; `required: true` or `default: ""`) and referenced from `env` as `"KEY": "${user_config.<option>}"` — mirror the `user_config` block in `manifest.json`. Never write `"KEY": ""` into `env`
- [ ] `npm run devcheck` passes
