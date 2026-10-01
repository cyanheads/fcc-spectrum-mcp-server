<div align="center">
  <h1>fcc-spectrum-mcp-server</h1>
  <p><b>Search FCC radio licenses, find nearby transmitter sites, and see who is licensed on a frequency via MCP. STDIO or Streamable HTTP.</b>
  <div>5 Tools • 1 Resource</div>
  </p>
</div>

<div align="center">

[![Version](https://img.shields.io/badge/Version-0.1.0-blue.svg?style=flat-square)](./CHANGELOG.md) [![License](https://img.shields.io/badge/License-Apache%202.0-orange.svg?style=flat-square)](./LICENSE) [![Docker](https://img.shields.io/badge/Docker-ghcr.io-2496ED?style=flat-square&logo=docker&logoColor=white)](https://github.com/users/cyanheads/packages/container/package/fcc-spectrum-mcp-server) [![MCP SDK](https://img.shields.io/badge/MCP%20SDK-^2.1.0-green.svg?style=flat-square)](https://modelcontextprotocol.io/) [![npm](https://img.shields.io/npm/v/%40cyanheads%2Ffcc-spectrum-mcp-server?style=flat-square&logo=npm&logoColor=white)](https://www.npmjs.com/package/@cyanheads/fcc-spectrum-mcp-server) [![TypeScript](https://img.shields.io/badge/TypeScript-^7.0.2-3178C6.svg?style=flat-square)](https://www.typescriptlang.org/) [![Bun](https://img.shields.io/badge/Bun-v1.4.0-blueviolet.svg?style=flat-square)](https://bun.sh/)

</div>

<div align="center">

[![Install in Claude Desktop](https://img.shields.io/badge/Install_in-Claude_Desktop-D97757?style=for-the-badge&logo=anthropic&logoColor=white)](https://github.com/cyanheads/fcc-spectrum-mcp-server/releases/latest/download/fcc-spectrum-mcp-server.mcpb) [![Install in Cursor](https://cursor.com/deeplink/mcp-install-dark.svg)](https://cursor.com/en/install-mcp?name=fcc-spectrum-mcp-server&config=eyJjb21tYW5kIjoibnB4IiwiYXJncyI6WyIteSIsIkBjeWFuaGVhZHMvZmNjLXNwZWN0cnVtLW1jcC1zZXJ2ZXIiXX0=) [![Install in VS Code](https://img.shields.io/badge/VS_Code-Install_Server-0098FF?style=for-the-badge&logo=visualstudiocode&logoColor=white)](https://vscode.dev/redirect?url=vscode:mcp/install?%7B%22name%22%3A%22fcc-spectrum-mcp-server%22%2C%22command%22%3A%22npx%22%2C%22args%22%3A%5B%22-y%22%2C%22%40cyanheads%2Ffcc-spectrum-mcp-server%22%5D%7D)

[![Framework](https://img.shields.io/badge/Built%20on-@cyanheads/mcp--ts--core-67E8F9?style=flat-square)](https://www.npmjs.com/package/@cyanheads/mcp-ts-core)

</div>

---

## Overview

US radio spectrum licensing from the FCC Universal Licensing System (ULS), served from a local SQLite index of the FCC's weekly and daily bulk files. Look up a callsign, licensee, or FCC Registration Number (FRN); read a license's sites, antennas, frequencies, power, and emission designators; find licensed transmitter sites within a radius of a point; and see who is authorized on a frequency or band, market-area spectrum blocks included. No API key, and no call to the FCC at request time. Runs as a stdio process or a local Streamable HTTP server.

The default index covers land mobile (private, commercial, and broadcast auxiliary), microwave, cellular, market-area wireless, paging, coast stations, broadband radio (BRS/EBS), and amateur licenses, plus spectrum leases. GMRS, ship, and aircraft licenses are opt-in. Broadcast stations (AM/FM/TV) and satellite earth stations are separate FCC systems and are not included.

### Tools

| Tool | Description |
|:---|:---|
| `fcc_spectrum_search_licenses` | Search licenses and spectrum leases by callsign, licensee name, FRN, radio service, status, or licensee state. |
| `fcc_spectrum_get_license` | Read one license or lease in full by callsign or USI: licensee, status and dates, locations, antennas, frequencies with emissions, market blocks, and lease links. |
| `fcc_spectrum_find_transmitters` | Find licensed transmitter sites within a radius of a coordinate, nearest first, with the frequencies authorized at each. |
| `fcc_spectrum_search_frequencies` | Find site assignments and market-area spectrum blocks whose occupied band overlaps a frequency or band. |
| `fcc_spectrum_list_reference` | Decode ULS codes (radio services, statuses, location and antenna types, applicant types, operator classes) and report index coverage and freshness. |

### Resources

| Resource | Description |
|:---|:---|
| `fcc-spectrum://license/{callsign}` | One license or lease by callsign as JSON — the first page `fcc_spectrum_get_license` returns. |

Also reachable via `fcc_spectrum_get_license`.

## Capability reference

### `fcc_spectrum_search_licenses` <sub>tool</sub>

- Filters: `callsign`, `licensee` (every word must match the start of a word in the name), `frn`, `radio_service`, and `state` (the licensee's mailing state) — at least one required; `status` narrows to `A` (default), `C`, `E`, `L`, `P`, `T`, `X`, or `any`
- `limit` 1–100 (default 25) with cursor paging; each row carries the `usi` to pass to `fcc_spectrum_get_license`, plus `isLease`, `licenseeRedacted`, and location and frequency counts
- Typed errors: `no_criteria`, `unknown_radio_service`, `service_not_indexed`, `invalid_cursor`, `index_not_ready`

---

### `fcc_spectrum_get_license` <sub>tool</sub>

- Exactly one of `callsign` or `usi` (`identifier_required` otherwise); a callsign shared by several records returns the active one, else the most recent, and lists the others in `otherCallsignRecords`
- Pages large records: whole locations up to 50 sites and 100 antennas per call, up to `max_frequencies` frequency rows (1–1000, default 100), and 100 leases; `nextLocationOffset` and `nextLeaseOffset` feed `location_offset` and `lease_offset` on the next call
- A miss returns `found: false` with `guidance` (plus up to 5 callsign-prefix `candidates`), not an error; `technicalRetained: false` marks a record whose status keeps no sites or frequencies

---

### `fcc_spectrum_find_transmitters` <sub>tool</sub>

- `latitude` / `longitude` as decimal degrees or DMS strings, `radius_km` 0.1–100 (default 5); optional `frequency_low` / `frequency_high` in `unit` (`kHz`, `MHz` default, `GHz`), `radio_service`, and `status` (`A` default, `L`, `X`, or `any` for all three)
- Sites nearest first, `limit` 1–100 (default 25) with cursor paging; each site lists up to `max_frequencies_per_site` frequencies (1–50, default 10), with `frequencyCount` carrying the full count
- Typed errors: `invalid_frequency_range`, `unknown_radio_service`, `service_not_indexed`, `invalid_cursor`, `index_not_ready`

---

### `fcc_spectrum_search_frequencies` <sub>tool</sub>

- `frequency_low` required, `frequency_high` optional, in `unit`; a site assignment matches when its occupied band (widened by its emission bandwidth) overlaps the query, a market block when its filed edges do; `kind` is `site`, `market`, or `both` (default)
- Narrow by `state`, `radio_service`, `licensee`, and `status` (`A` default, `L`, `X`, `any`); `limit` 1–200 (default 50) with cursor paging, frequency ascending; each row's `kind` says whether it is a site assignment or a market block
- Typed errors: `invalid_frequency_range`, `unknown_radio_service`, `service_not_indexed`, `invalid_cursor`, `index_not_ready`

---

### `fcc_spectrum_list_reference` <sub>tool</sub>

- `topic`: `radio_services`, `license_statuses`, `location_types`, `antenna_types`, `applicant_types`, `operator_classes`, or `coverage`; `filter` narrows `radio_services` to entries containing every word given
- `coverage` reports `index.status` (`none`, `building`, `ready`), per-group record, site, and frequency counts with snapshot times, and whether redaction is on; it works before the index is built

---

### `fcc-spectrum://license/{callsign}` <sub>resource</sub>

- The first page of `fcc_spectrum_get_license` for a callsign (up to 100 frequency rows) as `application/json`, with `dataAsOf`, location, site, and frequency totals, and a `notice` naming the tool call that reads the rest; cached 1 hour
- Typed errors: `index_not_ready`, `license_not_found`

## Features

Built on [`@cyanheads/mcp-ts-core`](https://github.com/cyanheads/mcp-ts-core): stdio and Streamable HTTP transports, pluggable auth (`none` / `jwt` / `oauth`), swappable storage (`in-memory`, `filesystem`, `Supabase`, `Cloudflare KV/R2/D1`), structured logging with optional OpenTelemetry tracing.

FCC ULS-specific:

- Keyless and local at request time — every query reads the SQLite index; network access is needed only to build and refresh it
- Index generations behind an atomic pointer — a rebuild writes a new file and the server switches to it within a minute, so the index being served is never modified in place
- Occupied-band frequency matching — each assignment's band is widened by the bandwidth parsed from its emission designators, so a query near a wide channel's edge still finds it
- Spectrum leases are first-class records — `isLease` marks them, the licensee shown is the lessee, and lease links are listed in both directions
- Site state is derived from coordinates when the filing leaves it blank (common for microwave and BRS/EBS), and flagged `stateFromCoordinates`
- Individual licensees are redacted by default, and contact details are never ingested — see [Individual-licensee redaction](#individual-licensee-redaction)

Agent-friendly output:

- Freshness and filter echo — every data response carries `dataAsOf`, and search tools echo `appliedFilters` with normalized values and defaults
- Truncation disclosure — `truncated`, `shown`, `cap`, and `totalCount` plus a `notice` that names the next call, so a partial page is never read as the whole
- Absent stays absent — fields ULS leaves blank are omitted rather than filled, and filed coordinates are kept as DMS text (`coordinatesDms`) when they fail validation
- Discriminated output — `found`, `kind`, `isLease`, `licenseeRedacted`, and `technicalRetained` let callers branch on data, not string parsing

## Getting started

> **The index must be built once before any search works — see [First-run setup](#first-run-setup).** The package does not ship FCC data; until `mirror:init` has run, data tools fail with `index_not_ready` and `fcc_spectrum_list_reference` with topic `coverage` reports the build state.

Add the following to your MCP client configuration file:

```json
{
  "mcpServers": {
    "fcc-spectrum-mcp-server": {
      "type": "stdio",
      "command": "bunx",
      "args": ["@cyanheads/fcc-spectrum-mcp-server@latest"],
      "env": {
        "MCP_TRANSPORT_TYPE": "stdio",
        "MCP_LOG_LEVEL": "info",
        "FCC_SPECTRUM_MIRROR_DIR": "/path/to/fcc-uls"
      }
    }
  }
}
```

Or with npx (no Bun required):

```json
{
  "mcpServers": {
    "fcc-spectrum-mcp-server": {
      "type": "stdio",
      "command": "npx",
      "args": ["-y", "@cyanheads/fcc-spectrum-mcp-server@latest"],
      "env": {
        "MCP_TRANSPORT_TYPE": "stdio",
        "MCP_LOG_LEVEL": "info",
        "FCC_SPECTRUM_MIRROR_DIR": "/path/to/fcc-uls"
      }
    }
  }
}
```

Or with Docker (mount a volume at `/usr/src/app/.mirror` so the index persists across containers):

```json
{
  "mcpServers": {
    "fcc-spectrum-mcp-server": {
      "type": "stdio",
      "command": "docker",
      "args": [
        "run", "-i", "--rm",
        "-e", "MCP_TRANSPORT_TYPE=stdio",
        "-v", "fcc-uls:/usr/src/app/.mirror",
        "ghcr.io/cyanheads/fcc-spectrum-mcp-server:latest"
      ]
    }
  }
}
```

For Streamable HTTP, set the transport and start the server:

```sh
MCP_TRANSPORT_TYPE=http MCP_HTTP_PORT=3010 FCC_SPECTRUM_MIRROR_DIR=/path/to/fcc-uls bun run start:http
# Server listens at http://localhost:3010/mcp
```

`FCC_SPECTRUM_MIRROR_DIR` must name the directory `mirror:init` built. A relative path resolves against the process's working directory, which an MCP client chooses, so use an absolute path.

### First-run setup

The index is built from the FCC's public ULS bulk files at `data.fcc.gov` — weekly full snapshots per service group, plus daily incrementals. On the default groups a build downloads about 1.1 GB of zips, one at a time; a measured build produced 3,270,502 license records and an index of about 1.8 GB in about 3 minutes.

Build it once from a source checkout (see [Installation](#installation)) or the Docker image:

```sh
# Download the weekly snapshots and build the index (resumable; skips when nothing is newer)
FCC_SPECTRUM_MIRROR_DIR=/path/to/fcc-uls bun run mirror:init

# Check it: SQLite integrity plus per-file line counts against the FCC's counts files
FCC_SPECTRUM_MIRROR_DIR=/path/to/fcc-uls bun run mirror:verify

# Apply the daily incrementals published since the last build
FCC_SPECTRUM_MIRROR_DIR=/path/to/fcc-uls bun run mirror:refresh
```

With Docker, run the same commands against the volume: `docker run --rm -v fcc-uls:/usr/src/app/.mirror ghcr.io/cyanheads/fcc-spectrum-mcp-server:latest bun run mirror:init`.

Keeping it current:

- **HTTP transport.** The server schedules the weekly rebuild on Sundays at 16:00 and the daily refresh at 17:00, in the process's local time (the Docker image runs in UTC; the FCC publishes snapshots Sunday morning US Eastern). A daily refresh that has fallen more than six days behind runs the weekly rebuild instead. Neither job runs until `mirror:init` has published a first index.
- **stdio.** Nothing is scheduled. Run `mirror:refresh` daily and `mirror:init` weekly from cron or another scheduler; daily files never remove licenses, so removals arrive with the weekly rebuild.
- **Disk.** A rebuild writes a new generation beside the one being served and keeps the downloaded zip until its group is loaded, so leave room for a second index plus the largest zip (about 420 MB). Older generations are deleted at the start of the next rebuild.
- **Concurrency.** An ingest lock in the index directory lets one `mirror:init` or `mirror:refresh` run (or scheduled job) write at a time; an interrupted `mirror:init` resumes from its last completed step when rerun.

### Prerequisites

- [Bun v1.4](https://bun.sh/) or higher (or Node.js v24+). `bun:sqlite` is built into Bun; under Node, install `better-sqlite3` beside the server (declared as an optional peer dependency).
- Disk for the index at `FCC_SPECTRUM_MIRROR_DIR`: about 1.8 GB on the default groups, plus rebuild room as above.
- Network access to `data.fcc.gov` when building or refreshing the index. Queries need none.

### Installation

For local development, or to build the index from source:

1. **Clone the repository:**

```sh
git clone https://github.com/cyanheads/fcc-spectrum-mcp-server.git
```

2. **Navigate into the directory:**

```sh
cd fcc-spectrum-mcp-server
```

3. **Install dependencies:**

```sh
bun install
```

4. **Build the index** (see [First-run setup](#first-run-setup)):

```sh
FCC_SPECTRUM_MIRROR_DIR=/path/to/fcc-uls bun run mirror:init
```

## Configuration

| Variable | Description | Default |
|:---|:---|:---|
| `FCC_SPECTRUM_MIRROR_DIR` | Directory holding the index generations, `current.json`, the ingest lock, and temporary zips. Use an absolute path; a relative one resolves against the working directory. | `.mirror/fcc-uls` |
| `FCC_SPECTRUM_SERVICES` | Comma-separated weekly service groups to index, case-insensitive. Opt-in: `gmrs`, `ship`, `aircr`. An unknown name fails startup and lists the valid set. | `LMpriv,LMcomm,LMbcast,micro,cell,market,paging,coast,mdsitfs,amat` |
| `FCC_SPECTRUM_REDACT_INDIVIDUALS` | Redact individual licensees and trustee names, and exclude individuals from name search. Only `false`, `0`, `no`, or `off` disables it; unset, empty, or anything else keeps it on. | `true` |
| `FCC_SPECTRUM_BASE_URL` | ULS bulk file host root, read only when building or refreshing the index. | `https://data.fcc.gov/download/pub/uls` |
| `MCP_TRANSPORT_TYPE` | Transport: `stdio` or `http`. | `stdio` |
| `MCP_SESSION_MODE` | Session mode: `auto` (resolves to stateful), `stateful`, or `stateless`. The server declares `stateless` in source because no tool asks the caller for input mid-call; setting this overrides that declaration. | `stateless` |
| `MCP_HTTP_PORT` | Port for the HTTP server. | `3010` |
| `MCP_HTTP_ENDPOINT_PATH` | HTTP endpoint path where the MCP server is mounted. | `/mcp` |
| `MCP_AUTH_MODE` | Auth mode: `none`, `jwt`, or `oauth`. | `none` |
| `MCP_LOG_LEVEL` | Log level (RFC 5424). | `info` |
| `LOGS_DIR` | Directory for log files (Node.js only). | `<project-root>/logs` |
| `OTEL_ENABLED` | Enable [OpenTelemetry instrumentation](https://github.com/cyanheads/mcp-ts-core/tree/main/docs/telemetry) (spans, metrics, completion logs). | `false` |

See [`.env.example`](./.env.example) for the full list of optional overrides.

### Service groups

The FCC splits its weekly snapshots into service groups, named as its files are. Adding a group takes effect at the next `mirror:init`; a removed group drops out at the next weekly rebuild.

| Group | Contents | Indexed |
|:---|:---|:---|
| `LMpriv` | Private land mobile (public safety, business, industrial) | default |
| `LMcomm` | Commercial land mobile | default |
| `LMbcast` | Broadcast auxiliary land mobile | default |
| `micro` | Point-to-point microwave | default |
| `cell` | Cellular | default |
| `market` | Market-area wireless (PCS, AWS, 700 MHz, 3.45 and 3.7 GHz, and other auctioned blocks) | default |
| `paging` | Paging | default |
| `coast` | Coast stations | default |
| `mdsitfs` | Broadband Radio Service and Educational Broadband Service (BRS/EBS) | default |
| `amat` | Amateur radio | default |
| `gmrs` | General Mobile Radio Service — licensee records only | opt-in |
| `ship` | Ship stations — licensee records only | opt-in |
| `aircr` | Aircraft stations — licensee records only | opt-in |

### Individual-licensee redaction

ULS records name the person behind many licenses, and not only amateur ones: individuals also hold land mobile, paging, and microwave licenses. `FCC_SPECTRUM_REDACT_INDIVIDUALS` is on by default and fails safe:

- A record is an individual's when its applicant type is `I`, or blank in the amateur and GMRS services. A blank type or type `H` (Other) in any service also counts when the filing carries a person's name parts, or when the licensee name contains no organization word (`Inc`, `County`, `Church`, `Wireless`, …), so an organization named without one is redacted too. While redaction is on, its licensee name and city are `null` with `licenseeRedacted: true`, and its sites' street addresses are omitted.
- Trustee names are withheld on every license, since a trustee is always a person.
- Licensee name search excludes individuals, and the response `notice` says so. A callsign, USI, or FRN lookup still returns the record, redacted.
- Coordinates, county, state, and technical data stay: they are the spectrum record.
- Redaction applies when a response is built, so changing the setting needs a restart, not a rebuild.

Licensee mailing street addresses, ZIP codes, PO boxes, attention lines, phone numbers, fax numbers, and email addresses are never ingested, for anyone.

## Known limitations

- **HTTP mode rebuilds in-process.** The scheduled weekly rebuild runs inside the server process and can slow responses while it runs.
- **Dense-band frequency searches return partial pages.** `fcc_spectrum_search_frequencies` over a crowded band (all of 150–174 MHz, or the whole spectrum) reads the band in frequency order and stops each call short. A page can hold fewer rows than `limit` and still carry `nextCursor`, and `totalCount` is then a lower bound (`totalIsLowerBound: true`). A sparse filter across a wide band can return several empty pages before its first rows; a `state`, `radio_service`, or `licensee` filter narrow enough to search directly keeps the exact count.
- **Sites, frequencies, and market blocks are kept only for live licenses** (`A` active, `L` pending legal, `X` term pending). Expired, cancelled, and terminated records keep their licensee, status, dates, and lease links.
- **No county-to-market mapping.** Market-area licenses carry a market code and name but not the counties inside the market, so state filtering reads the state codes in the market name. ULS cuts market names at 30 characters, which can drop the state.
- **Radius search sees only located sites.** Mobile, control-station, and temporary locations often file no coordinates.
- **Derived states are approximate near borders**, within about a kilometer of a state line; territories other than Puerto Rico get no derived state.
- **Removals lag up to a week.** Daily files never delete licenses; the weekly rebuild does. A refresh gap longer than the daily window forces a full rebuild.
- **Priority Access Licenses are not found by frequency.** ULS files each 3.5 GHz PAL as a 10 MHz channel width with no frequency; list them with `fcc_spectrum_search_licenses` and `radio_service` `PL`.
- **Frequencies at a shared location number cannot be tied to a site.** ULS files antennas and frequencies against the location number, so when a license files several sites under one number, no frequency can be placed at a single site.
- **Station class codes pass through undecoded** (`FB2`, `FXO`, `MO`).
- **Coordinates are NAD83 as filed**, with no datum shift; a few fail validation and appear only as DMS text.
- **A few implausible emission bandwidths pass.** A designator 20% of its frequency or wider is treated as a filing error and ignored; narrower implausible filings are taken as filed.

## Running the server

### Local development

- **Build and run:**

  ```sh
  # One-time build
  bun run rebuild

  # Build the index (see First-run setup)
  bun run mirror:init

  # Run the built server
  bun run start:stdio
  # or
  bun run start:http
  ```

- **Run checks and tests:**

  ```sh
  bun run devcheck   # Lint, format, typecheck, security
  bun run test       # Vitest test suite
  bun run lint:mcp   # Validate MCP definitions against spec
  ```

### Docker

```sh
docker build -t fcc-spectrum-mcp-server .
# Build the index once against the volume:
docker run --rm -v fcc-uls:/usr/src/app/.mirror fcc-spectrum-mcp-server bun run mirror:init
# Serve over HTTP:
docker run --rm -p 3010:3010 -v fcc-uls:/usr/src/app/.mirror fcc-spectrum-mcp-server
```

The Dockerfile defaults to HTTP transport with stateless sessions, ships the `mirror:init` / `mirror:refresh` / `mirror:verify` CLI, pre-creates a writable `.mirror` directory owned by the runtime user (mount a volume there), and logs to `/var/log/fcc-spectrum-mcp-server`. OpenTelemetry peer dependencies are installed by default — build with `--build-arg OTEL_ENABLED=false` to omit them.

## Project structure

| Directory | Purpose |
|:---|:---|
| `src/index.ts` | `createApp()` entry point — registers the tools and resource, composes the server instructions, inits the index service, and starts the ingest schedule under HTTP transport. |
| `src/config` | Server-specific environment variable parsing and validation with Zod. |
| `src/mcp-server/tools` | Tool definitions (`*.tool.ts`), shared input schemas, and format helpers. |
| `src/mcp-server/resources` | Resource definitions (`*.resource.ts`). |
| `src/services/uls` | ULS service — bulk client, zip reader, record parsers, ingester, index generations, the read path with its redaction chokepoint, and the ingest schedule. |
| `scripts/fcc-mirror-*.ts` | Index lifecycle CLI — `mirror:init`, `mirror:refresh`, `mirror:verify`. |
| `tests/` | Unit and integration tests mirroring `src/`, with fixture ULS records. |

## Development guide

See [`CLAUDE.md`/`AGENTS.md`](./CLAUDE.md) for development guidelines and architectural rules. The short version:

- Handlers throw, framework catches — no `try/catch` in tool logic
- Use `ctx.log` for request-scoped logging; data access goes through the ULS index service
- Register new tools and resources via the barrels in `src/mcp-server/*/definitions/index.ts`
- The index is the source of truth at runtime — build and refresh it out-of-band, keep blank ULS fields absent, and never fabricate a value

## Contributing

Issues are welcome. Run checks and tests before submitting:

```sh
bun run devcheck
bun run test
```

## License

Apache-2.0 — see [LICENSE](LICENSE) for details.

License data comes from the FCC Universal Licensing System (ULS), a US government work in the public domain (17 U.S.C. §105). Credit it as "FCC Universal Licensing System (ULS)" with the `dataAsOf` time each response carries. This project redistributes none of that data; operators download it from the FCC when building the index. This server is independent of the FCC and not endorsed by it.
