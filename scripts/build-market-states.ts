/**
 * @fileoverview Regenerate `src/services/uls/data/market-states.json`: the USPS states each FCC
 * market area covers, keyed by the ULS market code (`CMA001`, `BEA010`, `PEA416`), plus the
 * state of each county FIPS prefix. Sources, both FCC Office of Engineering and Technology
 * files fetched from transition.fcc.gov (www.fcc.gov refuses scripts):
 *
 * - `FCCCNTY2K.txt`, every county with its CMA, EA (`BEA`), MEA, MTA, BTA, REA, 220 MHz EAG
 *   (`EAG001`–`EAG006`), 700 MHz EAG (`EAG701`–`EAG706`), RPC, and VPC.
 * - `FCC_PEA_website.xlsx`, sheet `t_FCC_PEA_Counties`, every county with its PEA.
 *
 * and three rules: `IVM###` (218-219 MHz) shares the CMA numbering; `AMT###` is the list of
 * EAs 47 CFR 80.385(a)(3) gives each AMTS area; `SLC###` (700 MHz public safety state
 * licenses) is the state at that position in alphabetical USPS order with PW (Palau, not a
 * state this server filters on) counted. Gulf of Mexico areas list no state.
 *
 * BTAs and MTAs are Rand McNally definitions the FCC adopted; the table carries only which
 * states each one touches, never its counties, and the JSON's `source` field carries the
 * FCC's citation lines for both. Downloads are cached in the OS temp directory, outside the
 * repository; delete that directory to fetch fresh copies.
 *
 * Run by hand when a source changes: `bun run scripts/build-market-states.ts`. With
 * `--check`, it writes nothing and exits non-zero when the regenerated JSON differs from the
 * committed file.
 * @module scripts/build-market-states
 */

import { existsSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { STATE_NAME_TO_CODE, stateNameKey, USPS_CODES } from '../src/services/uls/codes.js';
import { openZipArchive, type ZipArchive } from '../src/services/uls/zip-reader.js';

const COUNTIES_URL =
  'https://transition.fcc.gov/bureaus/oet/info/maps/areas/data/2000/FCCCNTY2K.txt';
const PEA_URL = 'https://transition.fcc.gov/bureaus/oet/info/maps/areas/data/FCC_PEA_website.xlsx';
const PEA_SHEET = 't_FCC_PEA_Counties';
const CACHE_DIR = join(tmpdir(), 'fcc-spectrum-market-sources');
const OUTPUT = join(
  dirname(fileURLToPath(import.meta.url)),
  '..',
  'src',
  'services',
  'uls',
  'data',
  'market-states.json',
);

const SOURCE = [
  `FCC Office of Engineering and Technology, FCCCNTY2K.txt (counties to CMA, EA, MEA, MTA, BTA, REA, EAG, RPC, and VPC market areas): ${COUNTIES_URL}`,
  `FCC Office of Engineering and Technology, FCC_PEA_website.xlsx (counties to Partial Economic Areas): ${PEA_URL}`,
  '47 CFR 80.385(a)(3): the Economic Areas of each AMTS service area',
  'Basic Trading Areas delineated by the Rand McNally 1992 Commercial Atlas & Marketing Guide, 123rd Edition, at pages 38-39; extended and revised by the Federal Communications Commission, 59 FR 46195 (September 7, 1994)',
  'Major Trading Areas delineated by the Rand McNally 1992 Commercial Atlas & Marketing Guide, 123rd Edition, at pages 38-39, extended and excepted by the Federal Communications Commission, 59 FR 14115 (March 25, 1994)',
  'IVM areas follow the CMA numbering; SLC areas are states in alphabetical USPS order, PW (Palau) counted; Gulf of Mexico areas list no state',
];

/** County-file column → the market codes a county's number in it names. */
const COUNTY_COLUMNS: readonly [column: string, codes: (n: number) => string[]][] = [
  ['CMA', (n) => [`CMA${pad(n)}`, `IVM${pad(n)}`]],
  ['EA', (n) => [`BEA${pad(n)}`]],
  ['MEA', (n) => [`MEA${pad(n)}`]],
  ['MTA', (n) => [`MTA${pad(n)}`]],
  ['BTA', (n) => [`BTA${pad(n)}`]],
  ['REA', (n) => [`REA${pad(n)}`]],
  ['EAG_220', (n) => [`EAG${pad(n)}`]],
  ['EAG_700', (n) => [`EAG${700 + n}`]],
  ['RPC', (n) => [`RPC${pad(n)}`]],
  ['VPC', (n) => [`VPC${pad(n)}`]],
];

/** 47 CFR 80.385(a)(3): the EAs of AMTS areas 1–10, in order. */
const AMTS_AREAS = [
  '1-5, 10',
  '9, 11-23, 25, 42, 46',
  '24, 26-34, 37, 38, 40, 41, 174',
  '35, 36, 39, 43-45, 47-53, 67-107, 113, 116-120, 122-125, 127, 130-134, 176',
  '6-8, 54-66, 108, 109',
  '160-165',
  '147, 166-170',
  '172',
  '171',
  '110-112, 114-115, 121, 126, 128, 129, 135-146, 148-159',
];

/** The FCC's Gulf of Mexico BTAs (Zones A and B), which the county file assigns no county. */
const GULF_BTAS = ['BTA494', 'BTA495'];

/** The county file's spelling of the Gulf of Mexico and of American Samoa. */
const GULF_NAME = 'Gulf of Mexico';
const SAMOA_NAME = 'American Samoas';
/** The PEA workbook's state value for its Gulf of Mexico counties. */
const PEA_GULF = 'GM';

const pad = (n: number) => String(n).padStart(3, '0');

/** Every number in a list like `1-5, 10`. */
function numberList(spec: string): number[] {
  return spec.split(',').flatMap((part) => {
    const [from, to = from] = part.trim().split('-').map(Number);
    if (from === undefined || to === undefined || !(to >= from))
      throw new Error(`Bad range ${part}`);
    return Array.from({ length: to - from + 1 }, (_, i) => from + i);
  });
}

/** When the last download finished; downloads from the one host are spaced {@link FETCH_GAP_MS} apart. */
let lastFetch = 0;
const FETCH_GAP_MS = 3000;

/** The cached path of a source file, downloaded into the cache first when absent. */
async function source(url: string, name: string): Promise<string> {
  const path = join(CACHE_DIR, name);
  if (!existsSync(path)) {
    await sleep(Math.max(0, lastFetch + FETCH_GAP_MS - Date.now()));
    const response = await fetch(url, {
      headers: { 'User-Agent': 'fcc-spectrum-mcp-server/build-market-states' },
    });
    if (!response.ok) throw new Error(`GET ${url} answered ${response.status}`);
    await mkdir(CACHE_DIR, { recursive: true });
    await writeFile(path, Buffer.from(await response.arrayBuffer()));
    lastFetch = Date.now();
    console.log(`Fetched ${url}`);
  }
  return path;
}

/** Record that `key` exists, with `state` among its states; `null` for a Gulf county adds none. */
function addState<K>(map: Map<K, Set<string>>, key: K, state: string | null): void {
  const states = map.get(key) ?? new Set<string>();
  if (state) states.add(state);
  map.set(key, states);
}

/** USPS code of a county-file state name; `null` for the Gulf of Mexico. */
function countyState(name: string): string | null {
  if (name === GULF_NAME) return null;
  if (name === SAMOA_NAME) return 'AS';
  const code = STATE_NAME_TO_CODE.get(stateNameKey(name));
  if (!code) throw new Error(`FCCCNTY2K.txt names an unknown state "${name}"`);
  return code;
}

/** Read FCCCNTY2K.txt into `markets`; returns each FIPS state prefix's USPS code and each EA's states. */
function readCounties(text: string, markets: Map<string, Set<string>>) {
  const [header = '', ...lines] = text.trim().split(/\r?\n/);
  const columns = header.split(',');
  const fipsStates = new Map<string, string>();
  const eaStates = new Map<number, Set<string>>();
  for (const line of lines) {
    const fields = line.split(',');
    if (fields.length !== columns.length)
      throw new Error(`FCCCNTY2K.txt row "${line}" is malformed`);
    const row = Object.fromEntries(columns.map((column, i) => [column, fields[i] ?? '']));
    const state = countyState(row.STATE ?? '');
    const prefix = (row.FIPS ?? '').slice(0, 2);
    if (state) {
      const known = fipsStates.get(prefix);
      if (known && known !== state)
        throw new Error(`FIPS prefix ${prefix} is both ${known} and ${state}`);
      fipsStates.set(prefix, state);
    }
    for (const [column, codes] of COUNTY_COLUMNS) {
      const n = Number(row[column]);
      if (n) for (const code of codes(n)) addState(markets, code, state);
    }
    addState(eaStates, Number(row.EA), state);
  }
  return { fipsStates, eaStates };
}

async function entryText(archive: ZipArchive, name: string): Promise<string> {
  const entry = archive.find(name);
  if (!entry) throw new Error(`The PEA workbook has no ${name}`);
  const chunks: Buffer[] = [];
  for await (const chunk of await archive.openEntry(entry)) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString('utf8');
}

const unescapeXml = (text: string) =>
  text
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&');

/** The cell values of each row of one sheet in an xlsx workbook, keyed by column letter. */
async function readSheet(path: string, sheet: string): Promise<Record<string, string>[]> {
  const archive = await openZipArchive(path);
  try {
    const workbook = await entryText(archive, 'xl/workbook.xml');
    const relId = new RegExp(`<sheet [^>]*name="${sheet}"[^>]*r:id="([^"]+)"`).exec(workbook)?.[1];
    const rels = await entryText(archive, 'xl/_rels/workbook.xml.rels');
    const target = new RegExp(`Id="${relId}"[^>]*Target="([^"]+)"`).exec(rels)?.[1];
    if (!relId || !target) throw new Error(`The PEA workbook has no sheet ${sheet}`);
    const shared = [
      ...(await entryText(archive, 'xl/sharedStrings.xml')).matchAll(/<si>(.*?)<\/si>/gs),
    ].map(([, si = '']) =>
      unescapeXml([...si.matchAll(/<t[^>]*>(.*?)<\/t>/gs)].map(([, t]) => t).join('')),
    );
    const xml = await entryText(archive, `xl/${target}`);
    return [...xml.matchAll(/<row [^>]*>(.*?)<\/row>/gs)].map(([, cells = '']) =>
      Object.fromEntries(
        [...cells.matchAll(/<c r="([A-Z]+)\d+"([^>]*?)(?:\/>|>(.*?)<\/c>)/gs)].map(
          ([, column, attributes = '', body = '']) => {
            const value = unescapeXml(/<v>(.*?)<\/v>/s.exec(body)?.[1] ?? '');
            return [column, attributes.includes('t="s"') ? (shared[Number(value)] ?? '') : value];
          },
        ),
      ),
    );
  } finally {
    await archive.close();
  }
}

/** Read the PEA sheet (columns PEA number, FIPS, county, state) into `markets`. */
async function readPeas(path: string, markets: Map<string, Set<string>>): Promise<void> {
  const [header, ...rows] = await readSheet(path, PEA_SHEET);
  if (header?.A !== 'FCC_PEA_Number' || header.D !== 'State') {
    throw new Error(`Sheet ${PEA_SHEET} no longer has its PEA number and State columns`);
  }
  for (const row of rows) {
    const pea = Number(row.A);
    const state = row.D ?? '';
    if (!pea) throw new Error(`Sheet ${PEA_SHEET} row ${JSON.stringify(row)} has no PEA number`);
    if (state === PEA_GULF) {
      addState(markets, `PEA${pad(pea)}`, null);
    } else if ((USPS_CODES as readonly string[]).includes(state)) {
      addState(markets, `PEA${pad(pea)}`, state);
    } else {
      throw new Error(`Sheet ${PEA_SHEET} names an unknown state "${state}"`);
    }
  }
}

async function build(): Promise<string> {
  const countiesPath = await source(COUNTIES_URL, 'FCCCNTY2K.txt');
  const counties = new TextDecoder('latin1').decode(await readFile(countiesPath));
  const markets = new Map<string, Set<string>>();
  const { fipsStates, eaStates } = readCounties(counties, markets);
  await readPeas(await source(PEA_URL, 'FCC_PEA_website.xlsx'), markets);

  AMTS_AREAS.forEach((eas, i) => {
    const code = `AMT${pad(i + 1)}`;
    for (const ea of numberList(eas)) {
      const states = eaStates.get(ea);
      if (!states) throw new Error(`AMTS area ${i + 1} names EA ${ea}, which no county carries`);
      for (const state of states) addState(markets, code, state);
    }
  });
  for (const code of GULF_BTAS) addState(markets, code, null);
  [...USPS_CODES, 'PW'].sort().forEach((state, i) => {
    if (state !== 'PW') addState(markets, `SLC${pad(i + 1)}`, state);
  });

  const sorted = <T>(entries: Iterable<[string, T]>) =>
    Object.fromEntries([...entries].sort(([a], [b]) => (a < b ? -1 : 1)));
  return `${JSON.stringify({
    source: SOURCE,
    fipsStates: sorted(fipsStates),
    markets: sorted([...markets].map(([code, states]) => [code, [...states].sort()])),
  })}\n`;
}

const json = await build();
if (process.argv.includes('--check')) {
  const committed = existsSync(OUTPUT) ? await readFile(OUTPUT, 'utf8') : '';
  if (committed !== json) {
    console.error(`${OUTPUT} differs from what its sources regenerate; run without --check.`);
    process.exit(1);
  }
  console.log(`${OUTPUT} matches its sources byte for byte (${json.length} bytes).`);
} else {
  await writeFile(OUTPUT, json);
  const markets = Object.keys(JSON.parse(json).markets).length;
  console.log(`Wrote ${markets} markets to ${OUTPUT} (${json.length} bytes)`);
}
