/**
 * @fileoverview Regenerate `src/services/uls/data/us-states.json` from the Census Bureau
 * cartographic boundary file `cb_2024_us_state_20m` (50 states, DC, and Puerto Rico;
 * public domain). Downloads the shapefile zip, reads the `.shp` polygons and the `.dbf`
 * `STUSPS` column with a minimal reader, and writes compact GeoJSON: coordinates rounded
 * to 4 decimals, rings grouped into polygons with their holes, and a bbox per feature.
 * Run once by hand when the boundary vintage changes: `bun run scripts/build-state-boundaries.ts`.
 * @module scripts/build-state-boundaries
 */

import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { USPS_STATES } from '../src/services/uls/codes.js';
import { openZipArchive, type ZipArchive, type ZipEntry } from '../src/services/uls/zip-reader.js';

const SOURCE_URL = 'https://www2.census.gov/geo/tiger/GENZ2024/shp/cb_2024_us_state_20m.zip';
const SOURCE_NAME = 'US Census Bureau cartographic boundary file cb_2024_us_state_20m';
const OUTPUT = join(
  dirname(fileURLToPath(import.meta.url)),
  '..',
  'src',
  'services',
  'uls',
  'data',
  'us-states.json',
);
const SHAPE_POLYGON = 5;

type Point = [number, number];
type Ring = Point[];

async function readEntryBytes(archive: ZipArchive, entry: ZipEntry): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of await archive.openEntry(entry)) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks);
}

function entryBySuffix(archive: ZipArchive, suffix: string): ZipEntry {
  const entry = archive.entries.find((e) => e.name.toLowerCase().endsWith(suffix));
  if (!entry) throw new Error(`Boundary zip has no ${suffix} entry`);
  return entry;
}

/** The `STUSPS` value of every `.dbf` record, in record order. */
function readStateCodes(dbf: Buffer): string[] {
  const recordCount = dbf.readUInt32LE(4);
  const headerLength = dbf.readUInt16LE(8);
  const recordLength = dbf.readUInt16LE(10);
  let fieldOffset = 1; // byte 0 of each record is the deletion flag
  let target: { offset: number; length: number } | undefined;
  for (let pos = 32; pos < headerLength && dbf[pos] !== 0x0d; pos += 32) {
    const name = dbf
      .subarray(pos, pos + 11)
      .toString('latin1')
      .replace(/\0.*$/, '');
    const length = dbf[pos + 16] ?? 0;
    if (name === 'STUSPS') target = { offset: fieldOffset, length };
    fieldOffset += length;
  }
  if (!target) throw new Error('Boundary .dbf has no STUSPS field');
  const codes: string[] = [];
  for (let i = 0; i < recordCount; i++) {
    const start = headerLength + i * recordLength + target.offset;
    codes.push(
      dbf
        .subarray(start, start + target.length)
        .toString('latin1')
        .trim(),
    );
  }
  return codes;
}

const round = (value: number) => Math.round(value * 1e4) / 1e4;

/** The rings of every `.shp` polygon record, in record order, rounded and de-duplicated. */
function readPolygonRings(shp: Buffer): Ring[][] {
  const records: Ring[][] = [];
  let pos = 100;
  while (pos + 8 <= shp.length) {
    const contentBytes = shp.readInt32BE(pos + 4) * 2;
    const content = pos + 8;
    const shapeType = shp.readInt32LE(content);
    const rings: Ring[] = [];
    if (shapeType === SHAPE_POLYGON) {
      const partCount = shp.readInt32LE(content + 36);
      const pointCount = shp.readInt32LE(content + 40);
      const partsAt = content + 44;
      const pointsAt = partsAt + partCount * 4;
      for (let part = 0; part < partCount; part++) {
        const first = shp.readInt32LE(partsAt + part * 4);
        const end = part + 1 < partCount ? shp.readInt32LE(partsAt + (part + 1) * 4) : pointCount;
        const ring: Ring = [];
        for (let p = first; p < end; p++) {
          const point: Point = [
            round(shp.readDoubleLE(pointsAt + p * 16)),
            round(shp.readDoubleLE(pointsAt + p * 16 + 8)),
          ];
          const previous = ring.at(-1);
          if (!previous || previous[0] !== point[0] || previous[1] !== point[1]) ring.push(point);
        }
        if (ring.length >= 4) rings.push(ring);
      }
    }
    records.push(rings);
    pos = content + contentBytes;
  }
  return records;
}

/** Shoelace signed area; negative for the clockwise rings shapefiles use as outer boundaries. */
function signedArea(ring: Ring): number {
  let sum = 0;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i] as Point;
    const [xj, yj] = ring[j] as Point;
    sum += (xj - xi) * (yj + yi);
  }
  return sum / 2;
}

function ringContains(ring: Ring, [x, y]: Point): boolean {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i] as Point;
    const [xj, yj] = ring[j] as Point;
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

/**
 * Group rings into GeoJSON polygons: each clockwise (outer) ring with the
 * counter-clockwise holes inside it, re-wound to RFC 7946 order (outer counter-clockwise).
 */
function toPolygons(rings: Ring[]): Ring[][] {
  const outers = rings.filter((ring) => signedArea(ring) < 0);
  const holes = rings.filter((ring) => signedArea(ring) >= 0);
  const polygons = outers.map((outer) => [[...outer].reverse()]);
  for (const hole of holes) {
    const owner = outers.findIndex((outer) => ringContains(outer, hole[0] as Point));
    if (owner !== -1) polygons[owner]?.push([...hole].reverse());
  }
  return polygons;
}

function bboxOf(polygons: Ring[][]): [number, number, number, number] {
  let [minX, minY, maxX, maxY] = [Infinity, Infinity, -Infinity, -Infinity];
  for (const [x, y] of polygons.flat(2)) {
    minX = Math.min(minX, x);
    minY = Math.min(minY, y);
    maxX = Math.max(maxX, x);
    maxY = Math.max(maxY, y);
  }
  return [minX, minY, maxX, maxY];
}

async function main(): Promise<void> {
  const response = await fetch(SOURCE_URL, {
    headers: { 'User-Agent': 'fcc-spectrum-mcp-server/build-state-boundaries' },
  });
  if (!response.ok) throw new Error(`GET ${SOURCE_URL} answered ${response.status}`);
  const workDir = await mkdtemp(join(tmpdir(), 'fcc-state-boundaries-'));
  try {
    const zipPath = join(workDir, 'boundaries.zip');
    await writeFile(zipPath, Buffer.from(await response.arrayBuffer()));
    const archive = await openZipArchive(zipPath);
    const [shp, dbf] = await Promise.all([
      readEntryBytes(archive, entryBySuffix(archive, '.shp')),
      readEntryBytes(archive, entryBySuffix(archive, '.dbf')),
    ]);
    await archive.close();

    const codes = readStateCodes(dbf);
    const records = readPolygonRings(shp);
    if (codes.length !== records.length) {
      throw new Error(`.dbf has ${codes.length} records but .shp has ${records.length}`);
    }
    const features = codes
      .map((state, i) => ({ state, polygons: toPolygons(records[i] ?? []) }))
      .filter(({ state, polygons }) => state in USPS_STATES && polygons.length > 0)
      .sort((a, b) => a.state.localeCompare(b.state))
      .map(({ state, polygons }) => ({
        type: 'Feature',
        properties: { state },
        bbox: bboxOf(polygons),
        geometry: { type: 'MultiPolygon', coordinates: polygons },
      }));
    const collection = { type: 'FeatureCollection', source: SOURCE_NAME, features };
    await writeFile(OUTPUT, `${JSON.stringify(collection)}\n`);
    console.log(`Wrote ${features.length} features to ${OUTPUT}`);
  } finally {
    await rm(workDir, { recursive: true, force: true });
  }
}

await main();
