/**
 * @fileoverview Synthetic ULS fixtures: record-line builders sized by `RECORD_FIELD_COUNTS`,
 * a minimal ZIP writer with knobs for malformed archives, the weekly and daily fixture zips
 * (paging, BRS/EBS, amateur), and a fake `IngestClient` that serves them from memory. Every
 * callsign, name, and place-bound value here is invented; none is copied from FCC data.
 * @module tests/fixtures/uls-fixtures
 */

import { writeFile } from 'node:fs/promises';
import { crc32, deflateRawSync } from 'node:zlib';
import { serviceUnavailable } from '@cyanheads/mcp-ts-core/errors';
import type { UlsDownload, UlsRemoteFile } from '@/services/uls/bulk-client.js';
import { RECORD_FIELD_COUNTS, type RecordType } from '@/services/uls/dat.js';
import type { IngestClient } from '@/services/uls/ingest.js';

// --- Record lines ------------------------------------------------------------------------

/** Field values by 1-based position; unset positions are empty. */
export type FieldValues = Record<number, string | number | null | undefined>;

/** One pipe-delimited record line of `type` with the right field count. */
export function record(type: RecordType, values: FieldValues): string {
  const fields = Array.from({ length: RECORD_FIELD_COUNTS[type] }, () => '');
  fields[0] = type;
  for (const [position, value] of Object.entries(values)) {
    if (value !== null && value !== undefined) fields[Number(position) - 1] = String(value);
  }
  return fields.join('|');
}

/** HD — license header. */
export function hd(v: {
  usi: number;
  callsign?: string;
  status?: string;
  service?: string;
  grant?: string;
  expired?: string;
  cancelled?: string;
  effective?: string;
  lastAction?: string;
}): string {
  return record('HD', {
    2: v.usi,
    5: v.callsign,
    6: v.status,
    7: v.service,
    8: v.grant,
    9: v.expired,
    10: v.cancelled,
    43: v.effective,
    44: v.lastAction,
  });
}

/**
 * EN — entity; the private fields (name parts and contact details) are set so tests can
 * prove they are never ingested.
 */
export function en(v: {
  usi: number;
  entityType?: string;
  name?: string;
  first?: string;
  mi?: string;
  last?: string;
  suffix?: string;
  city?: string;
  state?: string;
  frn?: string;
  applicantType?: string;
  street?: string;
  zip?: string;
  phone?: string;
  email?: string;
}): string {
  return record('EN', {
    2: v.usi,
    6: v.entityType ?? 'L',
    8: v.name,
    9: v.first,
    10: v.mi,
    11: v.last,
    12: v.suffix,
    13: v.phone,
    15: v.email,
    16: v.street,
    17: v.city,
    18: v.state,
    19: v.zip,
    23: v.frn,
    24: v.applicantType,
  });
}

/** AM — amateur. */
export function am(v: {
  usi: number;
  operatorClass?: string;
  trusteeCallsign?: string;
  previousCallsign?: string;
  trusteeName?: string;
}): string {
  return record('AM', {
    2: v.usi,
    6: v.operatorClass,
    9: v.trusteeCallsign,
    16: v.previousCallsign,
    18: v.trusteeName,
  });
}

/** LL — lease link. */
export function ll(v: {
  leaseUsi: number;
  parentCallsign?: string;
  leaseId?: string;
  parentUsi: number;
}): string {
  return record('LL', { 2: v.leaseUsi, 5: v.parentCallsign, 6: v.leaseId, 7: v.parentUsi });
}

/** A DMS coordinate as its four fields: degrees, minutes, seconds, direction. */
export type Dms = [number | string, number | string, number | string, string];

/** LO — location. */
export function lo(v: {
  usi: number;
  number: number;
  type?: string;
  locationClass?: string;
  address?: string;
  city?: string;
  county?: string;
  state?: string;
  radiusKm?: number;
  groundElevation?: number;
  lat?: Dms;
  lon?: Dms;
  asr?: string;
  supportHeight?: number;
  overallHeight?: number;
  structureType?: string;
  name?: string;
}): string {
  const [latD, latM, latS, latDir] = v.lat ?? ['', '', '', ''];
  const [lonD, lonM, lonS, lonDir] = v.lon ?? ['', '', '', ''];
  return record('LO', {
    2: v.usi,
    7: v.type,
    8: v.locationClass,
    9: v.number,
    12: v.address,
    13: v.city,
    14: v.county,
    15: v.state,
    16: v.radiusKm,
    19: v.groundElevation,
    20: latD,
    21: latM,
    22: latS,
    23: latDir,
    24: lonD,
    25: lonM,
    26: lonS,
    27: lonDir,
    38: v.asr,
    39: v.supportHeight,
    40: v.overallHeight,
    41: v.structureType,
    43: v.name,
  });
}

/** AN — antenna. */
export function an(v: {
  usi: number;
  antenna: number;
  location: number;
  type?: string;
  heightToTip?: number;
  heightToCenter?: number;
  make?: string;
  model?: string;
  polarization?: string;
  beamwidth?: number;
  gain?: number;
  azimuth?: number;
  haat?: number;
}): string {
  return record('AN', {
    2: v.usi,
    7: v.antenna,
    8: v.location,
    10: v.type,
    11: v.heightToTip,
    12: v.heightToCenter,
    13: v.make,
    14: v.model,
    16: v.polarization,
    17: v.beamwidth,
    18: v.gain,
    19: v.azimuth,
    20: v.haat,
  });
}

/** FR — frequency. */
export function fr(v: {
  usi: number;
  location: number;
  antenna: number;
  seq: number;
  stationClass?: string;
  frequency?: number | string;
  upper?: number;
  powerOutput?: number;
  erp?: number;
  eirp?: number;
  txMake?: string;
  txModel?: string;
}): string {
  return record('FR', {
    2: v.usi,
    7: v.location,
    8: v.antenna,
    9: v.stationClass,
    11: v.frequency,
    12: v.upper,
    16: v.powerOutput,
    17: v.erp,
    21: v.eirp,
    22: v.txMake,
    23: v.txModel,
    27: v.seq,
  });
}

/** EM — emission designator of the FR row with the same `(usi, location, antenna, seq)`. */
export function em(v: {
  usi: number;
  location: number;
  antenna: number;
  seq: number;
  code: string;
  frequency?: number;
}): string {
  return record('EM', {
    2: v.usi,
    6: v.location,
    7: v.antenna,
    8: v.frequency,
    10: v.code,
    13: v.seq,
  });
}

/** MK — market. */
export function mk(v: { usi: number; code?: string; block?: string; name?: string }): string {
  return record('MK', { 2: v.usi, 6: v.code, 7: v.block, 9: v.name });
}

/** MF — market frequency block. */
export function mf(v: { usi: number; partition?: number; lower: number; upper?: number }): string {
  return record('MF', { 2: v.usi, 6: v.partition, 7: v.lower, 8: v.upper });
}

/** A `.dat` body: CRLF line endings, as ULS ships them. */
export function datFile(lines: readonly string[]): string {
  return lines.map((line) => `${line}\r\n`).join('');
}

/** A `counts` file: the creation header, then one `<count> <path>/<TYPE>.dat` line per type. */
export function countsFile(created: string, counts: Record<string, number> = {}): string {
  const lines = [`File Creation Date: ${created}`];
  for (const [type, count] of Object.entries(counts)) {
    lines.push(`${count} /home/pubacc/scripts/licweekzipdata/${type}.dat`);
  }
  return `${lines.join('\r\n')}\r\n`;
}

// --- ZIP writer --------------------------------------------------------------------------

/** One archive member. */
export interface ZipEntrySpec {
  data: string | Uint8Array;
  /** Raw general-purpose flag bits (0x1 encrypted, 0x800 UTF-8 name). */
  flags?: number;
  /** Extra-field bytes in the local header only (the reader must skip them). */
  localExtra?: number;
  /** `deflate` (default) or `store`. */
  method?: 'deflate' | 'store';
  /** Method number written to both headers; the data is stored as-is. */
  methodCode?: number;
  name: string;
  /** Write `0xFFFFFFFF` sizes in the central directory, as a ZIP64 entry does. */
  zip64Sizes?: boolean;
}

/** Archive-level knobs for malformed-archive tests. */
export interface ZipOptions {
  comment?: string;
  /** Central-directory offset written to the EOCD (default: the real offset). */
  directoryOffset?: number;
  diskNumber?: number;
  /** Total entry count written to the EOCD (default: the real count). */
  totalEntries?: number;
  /** Place a ZIP64 end-of-central-directory locator right before the EOCD. */
  zip64Locator?: boolean;
}

/** Build a ZIP archive in memory. */
export function buildZip(entries: readonly ZipEntrySpec[], options: ZipOptions = {}): Buffer {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  for (const entry of entries) {
    const raw =
      typeof entry.data === 'string' ? Buffer.from(entry.data, 'utf8') : Buffer.from(entry.data);
    const deflate = entry.methodCode === undefined && (entry.method ?? 'deflate') === 'deflate';
    const body = deflate ? deflateRawSync(raw) : raw;
    const method = entry.methodCode ?? (deflate ? 8 : 0);
    const crc = crc32(raw);
    const name = Buffer.from(entry.name, 'utf8');
    const flags = entry.flags ?? 0;
    const extra = Buffer.alloc(entry.localExtra ?? 0, 0x41);

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(flags, 6);
    local.writeUInt16LE(method, 8);
    local.writeUInt16LE(0, 10);
    local.writeUInt16LE(0x5b3b, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(body.length, 18);
    local.writeUInt32LE(raw.length, 22);
    local.writeUInt16LE(name.length, 26);
    local.writeUInt16LE(extra.length, 28);
    const localRecord = Buffer.concat([local, name, extra, body]);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(flags, 8);
    central.writeUInt16LE(method, 10);
    central.writeUInt16LE(0, 12);
    central.writeUInt16LE(0x5b3b, 14);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(entry.zip64Sizes ? 0xffffffff : body.length, 20);
    central.writeUInt32LE(entry.zip64Sizes ? 0xffffffff : raw.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt16LE(0, 30);
    central.writeUInt16LE(0, 32);
    central.writeUInt16LE(0, 34);
    central.writeUInt16LE(0, 36);
    central.writeUInt32LE(0, 38);
    central.writeUInt32LE(offset, 42);
    centrals.push(Buffer.concat([central, name]));

    locals.push(localRecord);
    offset += localRecord.length;
  }
  const directory = Buffer.concat(centrals);
  const comment = Buffer.from(options.comment ?? '', 'utf8');
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(options.diskNumber ?? 0, 4);
  eocd.writeUInt16LE(0, 6);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(options.totalEntries ?? entries.length, 10);
  eocd.writeUInt32LE(directory.length, 12);
  eocd.writeUInt32LE(options.directoryOffset ?? offset, 16);
  eocd.writeUInt16LE(comment.length, 20);
  const locator = Buffer.alloc(options.zip64Locator ? 20 : 0);
  if (options.zip64Locator) locator.writeUInt32LE(0x07064b50, 0);
  return Buffer.concat([...locals, directory, locator, eocd, comment]);
}

// --- Fixture dataset ---------------------------------------------------------------------

/** A zip the fake client serves, with the `Last-Modified` it reports. */
export interface FixtureFile {
  /** `counts` creation time as the ingester records it (UTC ISO 8601). */
  countsCreated: string;
  lastModified: string;
  zip: Buffer;
}

/** Weekly paging snapshot (radio service CD, plus one unlabeled code `ZQ`). */
export const PAGING_WEEKLY: FixtureFile = {
  countsCreated: '2026-09-27T13:38:53Z',
  lastModified: '2026-09-27T13:38:55Z',
  zip: buildZip([
    {
      name: 'counts',
      data: countsFile('Sun Sep 27 09:38:53 EDT 2026', { HD: 12, EN: 11, LO: 10, FR: 11 }),
    },
    {
      name: 'HD.dat',
      data: datFile([
        hd({
          usi: 1001,
          callsign: 'KZZ901',
          status: 'A',
          service: 'CD',
          grant: '03/01/2021',
          expired: '03/01/2031',
          effective: '03/01/2021',
          lastAction: '03/02/2021',
        }),
        hd({
          usi: 1002,
          callsign: 'KZZ902',
          status: 'C',
          service: 'CD',
          grant: '01/10/2010',
          cancelled: '06/30/2020',
        }),
        hd({ usi: 1003, callsign: 'KZZ903', status: 'A', service: 'CD', grant: '05/05/2022' }),
        hd({
          usi: 1005,
          callsign: 'KZZ901',
          status: 'E',
          service: 'CD',
          grant: '02/01/2001',
          expired: '02/01/2011',
          lastAction: '02/02/2011',
        }),
        hd({ usi: 1006, callsign: 'KZZ906', status: 'X', service: 'CD', grant: '07/07/2017' }),
        hd({ usi: 1007, callsign: 'KZZ907', status: 'L', service: 'CD', grant: '08/08/2018' }),
        hd({ usi: 1008, callsign: 'KZZ908', status: 'A', service: 'ZQ', grant: '09/09/2019' }),
        hd({ usi: 1009, callsign: 'KZZ909', status: 'A', service: 'CD', grant: '10/10/2020' }),
        'HD|1010|too|few|fields',
        hd({ usi: 1011, callsign: 'KZZ911', service: 'CD' }),
        hd({ usi: 1001, callsign: 'KZZ999', status: 'T', service: 'CD' }),
      ]),
    },
    {
      name: 'EN.dat',
      data: datFile([
        en({ usi: 1001, entityType: 'CL', name: 'Contact Person Example', city: 'NOWHERE' }),
        en({
          usi: 1001,
          name: 'Example Paging Co',
          city: 'SEATTLE',
          state: 'WA',
          frn: '0001234567',
          applicantType: 'C',
          street: '100 Private Way',
          zip: '98101',
          phone: '2065550100',
          email: 'private@example.test',
        }),
        en({
          usi: 1002,
          name: 'Retired Relay Partners',
          city: 'TACOMA',
          state: 'WA',
          frn: '0007654321',
          applicantType: 'E',
        }),
        en({
          usi: 1003,
          name: 'Pat Q Example',
          city: 'SPOKANE',
          state: 'WA',
          frn: '0005550001',
          applicantType: 'I',
        }),
        en({
          usi: 1005,
          name: 'Example Paging Co',
          city: 'SEATTLE',
          state: 'WA',
          frn: '0001234567',
          applicantType: 'C',
        }),
        en({
          usi: 1006,
          name: 'Tri City Paging LLC',
          city: 'PORTLAND',
          state: 'OR',
          applicantType: 'L',
        }),
        // A CR inside a field survives the CRLF line split; a `|` cannot occur inside a ULS field.
        en({
          usi: 1007,
          name: 'Carriage\rReturn Paging',
          city: 'BOISE',
          state: 'ID',
          frn: '0002223333',
          applicantType: 'C',
        }),
        en({
          usi: 1008,
          name: 'Unlisted Service Co',
          city: 'SEATTLE',
          state: 'WA',
          applicantType: 'C',
        }),
        en({ usi: 1009, name: 'Aleutian Relay Co', city: 'ADAK', state: 'AK', applicantType: 'C' }),
        'EN|1009|broken',
      ]),
    },
    {
      name: 'LO.dat',
      data: datFile([
        lo({
          usi: 1001,
          number: 1,
          type: 'F',
          locationClass: 'T',
          address: '1 Tower Rd',
          city: 'SEATTLE',
          county: 'KING',
          state: 'WA',
          groundElevation: 50.3,
          lat: [47, 36, 22.3, 'N'],
          lon: [122, 19, 55.6, 'W'],
          asr: '1012345',
          supportHeight: 30,
          overallHeight: 45.5,
          structureType: 'TOWER',
          name: 'Seattle Hill',
        }),
        lo({
          usi: 1001,
          number: 2,
          type: 'F',
          city: 'TACOMA',
          lat: [47, 15, 10.4, 'N'],
          lon: [122, 26, 39.5, 'W'],
        }),
        lo({
          usi: 1002,
          number: 1,
          type: 'F',
          state: 'WA',
          lat: [47, 0, 0, 'N'],
          lon: [122, 0, 0, 'W'],
        }),
        lo({
          usi: 1003,
          number: 1,
          type: 'F',
          address: '42 Private Lane',
          city: 'SPOKANE',
          state: 'wa',
          lat: [47, 39, 32, 'N'],
          lon: [117, 25, 33, 'W'],
        }),
        lo({
          usi: 1006,
          number: 1,
          type: 'F',
          city: 'PORTLAND',
          state: 'OR',
          lat: [45, 30, 54.7, 'N'],
          lon: [122, 40, 42.2, 'W'],
        }),
        lo({
          usi: 1007,
          number: 1,
          type: 'F',
          state: 'ID',
          lat: [43, 61, 0, 'N'],
          lon: [116, 12, 0, 'W'],
        }),
        lo({ usi: 1008, number: 1, lat: [47, 36, 30, 'N'], lon: [122, 19, 50, 'W'] }),
        lo({ usi: 1009, number: 1, type: 'F', lat: [52, 0, 0, 'N'], lon: [179, 48, 0, 'W'] }),
        'LO|1009|short',
      ]),
    },
    {
      name: 'AN.dat',
      data: datFile([
        an({
          usi: 1001,
          antenna: 1,
          location: 1,
          type: 'T',
          heightToTip: 45,
          heightToCenter: 40,
          make: 'ANTCO',
          model: 'A-100',
          polarization: 'V',
          beamwidth: 360,
          gain: 6.1,
          azimuth: 0,
          haat: 120,
        }),
        an({ usi: 1001, antenna: 1, location: 2, type: 'T' }),
        an({ usi: 1002, antenna: 1, location: 1, type: 'T' }),
        an({ usi: 1003, antenna: 1, location: 1, type: 'T' }),
        an({ usi: 1006, antenna: 1, location: 1, type: 'T' }),
        an({ usi: 1007, antenna: 1, location: 1, type: 'T' }),
        an({ usi: 1008, antenna: 1, location: 1, type: 'T' }),
        an({ usi: 1009, antenna: 1, location: 1, type: 'T' }),
      ]),
    },
    {
      name: 'FR.dat',
      data: datFile([
        fr({
          usi: 1001,
          location: 1,
          antenna: 1,
          seq: 1,
          stationClass: 'FB2',
          frequency: 152.24,
          powerOutput: 100,
          erp: 250,
          txMake: 'TXCO',
          txModel: 'T1',
        }),
        fr({
          usi: 1001,
          location: 1,
          antenna: 1,
          seq: 2,
          stationClass: 'FB2',
          frequency: 152.24,
          erp: 300,
          txModel: 'T2',
        }),
        fr({
          usi: 1001,
          location: 1,
          antenna: 1,
          seq: 3,
          stationClass: 'FB',
          frequency: 454.1,
          erp: 50,
        }),
        fr({
          usi: 1001,
          location: 2,
          antenna: 1,
          seq: 1,
          stationClass: 'FB2',
          frequency: 931.0125,
          erp: 500,
        }),
        fr({ usi: 1002, location: 1, antenna: 1, seq: 1, frequency: 152.5 }),
        fr({ usi: 1003, location: 1, antenna: 1, seq: 1, stationClass: 'FB', frequency: 158.7 }),
        fr({
          usi: 1006,
          location: 1,
          antenna: 1,
          seq: 1,
          stationClass: 'FB2',
          frequency: 152.84,
          erp: 200,
        }),
        fr({ usi: 1007, location: 1, antenna: 1, seq: 1, stationClass: 'MO', frequency: 152.24 }),
        fr({
          usi: 1008,
          location: 1,
          antenna: 1,
          seq: 1,
          stationClass: 'FB6',
          frequency: 929.6125,
        }),
        fr({ usi: 1009, location: 1, antenna: 1, seq: 1, stationClass: 'FB', frequency: 929.5 }),
        fr({ usi: 1009, location: 1, antenna: 1, seq: 2, stationClass: 'FB' }),
      ]),
    },
    {
      name: 'EM.dat',
      data: datFile([
        em({ usi: 1001, location: 1, antenna: 1, seq: 1, code: '11K2F3E', frequency: 152.24 }),
        em({ usi: 1001, location: 1, antenna: 1, seq: 1, code: '16K0F3E', frequency: 152.24 }),
        em({ usi: 1001, location: 1, antenna: 1, seq: 2, code: '11K2F3E', frequency: 152.24 }),
        em({ usi: 1001, location: 2, antenna: 1, seq: 1, code: '20K0F1D', frequency: 931.0125 }),
        em({ usi: 1001, location: 1, antenna: 1, seq: 9, code: '11K2F3E' }),
        em({ usi: 1002, location: 1, antenna: 1, seq: 1, code: '11K2F3E' }),
        em({ usi: 1003, location: 1, antenna: 1, seq: 1, code: '11K2F3E' }),
        em({ usi: 1006, location: 1, antenna: 1, seq: 1, code: '11k2f3e' }),
        em({ usi: 1009, location: 1, antenna: 1, seq: 1, code: 'XYZ' }),
      ]),
    },
    { name: 'CO.dat', data: datFile(['CO|1001|ignored comment']) },
  ]),
};

/** Weekly BRS/EBS snapshot: leases (both directions), market blocks, blank-callsign records. */
export const MDSITFS_WEEKLY: FixtureFile = {
  countsCreated: '2026-09-27T13:40:45Z',
  lastModified: '2026-09-27T13:40:47Z',
  zip: buildZip([
    { name: 'counts', data: countsFile('Sun Sep 27 09:40:45 EDT 2026', { HD: 8, ll: 3 }) },
    {
      name: 'HD.dat',
      data: datFile([
        hd({ usi: 2001, callsign: 'KZZ801', status: 'A', service: 'BR', grant: '04/04/2014' }),
        hd({ usi: 2002, callsign: 'L000000001', status: 'A', service: 'BR', grant: '05/05/2015' }),
        hd({ usi: 2003, callsign: 'KZZ803', status: 'E', service: 'ED', grant: '06/06/2006' }),
        hd({ usi: 2004, callsign: 'L000000002', status: 'A', service: 'BR', grant: '07/07/2017' }),
        hd({ usi: 2005, callsign: 'KZZ805', status: 'A', service: 'ED', grant: '08/08/2008' }),
        hd({ usi: 2006, callsign: 'L000000003', status: 'A', service: 'BR', grant: '09/09/2019' }),
        hd({ usi: 2007, status: 'E', service: 'BR', grant: '01/01/1999' }),
        hd({ usi: 2008, status: 'E', service: 'BR', grant: '01/02/1999' }),
      ]),
    },
    {
      name: 'EN.dat',
      data: datFile([
        en({
          usi: 2001,
          name: 'Sample Broadband Inc',
          city: 'FARGO',
          state: 'ND',
          frn: '0003334444',
          applicantType: 'C',
        }),
        en({
          usi: 2002,
          name: 'Leaseholder Wireless LLC',
          city: 'MINNEAPOLIS',
          state: 'MN',
          frn: '0004445555',
          applicantType: 'L',
        }),
        en({ usi: 2003, name: 'Education Band Trust', state: 'ND', applicantType: 'T' }),
        en({ usi: 2004, name: 'Second Lessee Networks', state: 'ND', applicantType: 'L' }),
        en({
          usi: 2005,
          name: 'Valley Learning Network',
          city: 'BAKERSFIELD',
          state: 'CA',
          applicantType: 'G',
        }),
        en({ usi: 2006, name: 'Orphan Lease Holdings', state: 'SD', applicantType: 'L' }),
        en({ usi: 2007, name: 'Legacy Broadband Co', state: 'ND', applicantType: 'C' }),
        en({ usi: 2008, name: 'Legacy Broadband Co', state: 'ND', applicantType: 'C' }),
      ]),
    },
    {
      name: 'MK.dat',
      data: datFile([
        mk({ usi: 2001, code: 'BTA144', block: 'A1', name: 'Fargo-Moorhead, ND-MN' }),
        mk({ usi: 2002, code: 'BTA144', block: 'A1', name: 'Fargo-Moorhead, ND-MN' }),
        mk({ usi: 2003, code: 'P35', name: 'P35 GSA' }),
        mk({ usi: 2004, code: 'BTA144', block: 'A2', name: 'Fargo-Moorhead, ND-MN' }),
        mk({ usi: 2005, code: 'BTA028', block: 'B', name: 'Bakersfield, CA' }),
        mk({ usi: 2006, code: 'BTA999', name: 'Sample Market/Other, ND/SD' }),
      ]),
    },
    {
      name: 'll.dat',
      data: datFile([
        ll({ leaseUsi: 2002, parentCallsign: 'KZZ801', leaseId: 'L000000001', parentUsi: 2001 }),
        ll({ leaseUsi: 2004, parentCallsign: 'KZZ801', leaseId: 'L000000002', parentUsi: 2001 }),
        ll({ leaseUsi: 2006, parentCallsign: 'KZZ999', leaseId: 'L000000003', parentUsi: 9999 }),
      ]),
    },
    {
      name: 'LO.dat',
      data: datFile([
        lo({ usi: 2001, number: 1, type: 'F', lat: [46, 52, 38, 'N'], lon: [96, 47, 23, 'W'] }),
        lo({
          usi: 2001,
          number: 2,
          type: 'F',
          state: 'MN',
          lat: [46, 52, 26, 'N'],
          lon: [96, 46, 4, 'W'],
        }),
        lo({
          usi: 2005,
          number: 1,
          type: 'F',
          state: 'CA',
          lat: [35, 22, 24, 'N'],
          lon: [119, 1, 6, 'W'],
        }),
      ]),
    },
    {
      name: 'AN.dat',
      data: datFile([
        an({ usi: 2001, antenna: 1, location: 1, type: 'T' }),
        an({ usi: 2001, antenna: 1, location: 2, type: 'T' }),
        an({ usi: 2005, antenna: 1, location: 1, type: 'T' }),
      ]),
    },
    {
      name: 'FR.dat',
      data: datFile([
        fr({ usi: 2001, location: 1, antenna: 1, seq: 1, frequency: 2500, upper: 2506, eirp: 60 }),
        fr({ usi: 2001, location: 2, antenna: 1, seq: 1, frequency: 2512, upper: 2518, eirp: 55 }),
        fr({ usi: 2005, location: 1, antenna: 1, seq: 1, frequency: 2650, upper: 2656 }),
      ]),
    },
    {
      name: 'EM.dat',
      data: datFile([
        em({ usi: 2001, location: 1, antenna: 1, seq: 1, code: '6M00D1D' }),
        em({ usi: 2001, location: 2, antenna: 1, seq: 1, code: '6M00D1D' }),
        em({ usi: 2005, location: 1, antenna: 1, seq: 1, code: '5M50G7W' }),
      ]),
    },
    {
      name: 'MF.dat',
      data: datFile([
        mf({ usi: 2001, partition: 1, lower: 2496, upper: 2502 }),
        mf({ usi: 2001, lower: 2502, upper: 2508 }),
        mf({ usi: 2002, partition: 1, lower: 2496, upper: 2502 }),
        mf({ usi: 2003, partition: 1, lower: 2500, upper: 2506 }),
        mf({ usi: 2004, partition: 2, lower: 2524, upper: 2530 }),
        mf({ usi: 2005, partition: 1, lower: 2650, upper: 2656 }),
        mf({ usi: 2006, partition: 1, lower: 2618, upper: 2624 }),
      ]),
    },
  ]),
};

/** Weekly amateur snapshot: HD, EN, AM only; a blank applicant type and a club trustee. */
export const AMAT_WEEKLY: FixtureFile = {
  countsCreated: '2026-09-27T13:44:10Z',
  lastModified: '2026-09-27T13:44:12Z',
  zip: buildZip([
    { name: 'counts', data: countsFile('Sun Sep 27 09:44:10 EDT 2026', { HD: 3, EN: 3, AM: 3 }) },
    {
      name: 'HD.dat',
      data: datFile([
        hd({ usi: 3001, callsign: 'KZ1AAA', status: 'A', service: 'HA', grant: '01/01/2020' }),
        hd({ usi: 3002, callsign: 'KZ1CLB', status: 'A', service: 'HA', grant: '01/01/2021' }),
        hd({ usi: 3003, callsign: 'KZ1BBB', status: 'A', service: 'HA', grant: '01/01/2022' }),
      ]),
    },
    {
      name: 'EN.dat',
      data: datFile([
        en({ usi: 3001, name: 'Alex Amateur Example', city: 'DENVER', state: 'CO' }),
        en({
          usi: 3002,
          name: 'Sample Radio Club',
          city: 'DENVER',
          state: 'CO',
          applicantType: 'B',
        }),
        en({
          usi: 3003,
          name: 'Blair Example Operator',
          city: 'BOULDER',
          state: 'CO',
          applicantType: 'I',
        }),
      ]),
    },
    {
      name: 'AM.dat',
      data: datFile([
        am({ usi: 3001, operatorClass: 'E', previousCallsign: 'KZ1ZZZ' }),
        am({ usi: 3002, trusteeCallsign: 'KZ1AAA', trusteeName: 'Trustee Person Example' }),
        am({ usi: 3003, operatorClass: 'T' }),
      ]),
    },
  ]),
};

/**
 * Monday's paging daily: 1001 turns cancelled and renamed, 1006 moves from X to A on a new
 * frequency, 1100 is new under an indexed code, and 1101 is new under a code no indexed
 * group carries.
 */
export const DAILY_PG_MON: FixtureFile = {
  countsCreated: '2026-09-28T12:01:10Z',
  lastModified: '2026-09-28T12:01:12Z',
  zip: buildZip([
    { name: 'counts', data: countsFile('Mon Sep 28 08:01:10 EDT 2026', { HD: 4 }) },
    {
      name: 'HD.dat',
      data: datFile([
        hd({
          usi: 1001,
          callsign: 'KZZ901',
          status: 'C',
          service: 'CD',
          grant: '03/01/2021',
          cancelled: '09/27/2026',
          lastAction: '09/27/2026',
        }),
        hd({ usi: 1006, callsign: 'KZZ906', status: 'A', service: 'CD', grant: '07/07/2017' }),
        hd({ usi: 1100, callsign: 'KZZ100', status: 'A', service: 'CD', grant: '09/28/2026' }),
        hd({ usi: 1101, callsign: 'KZZ101', status: 'A', service: 'WZ', grant: '09/28/2026' }),
      ]),
    },
    {
      name: 'EN.dat',
      data: datFile([
        en({ usi: 1001, name: 'Example Paging Co Renamed', state: 'WA', applicantType: 'C' }),
        en({ usi: 1006, name: 'Tri City Paging LLC', state: 'OR', applicantType: 'L' }),
        en({ usi: 1100, name: 'New Paging Venture LLC', state: 'WA', applicantType: 'L' }),
        en({ usi: 1101, name: 'Unindexed Service LLC', state: 'WA', applicantType: 'L' }),
      ]),
    },
    {
      name: 'LO.dat',
      data: datFile([
        lo({
          usi: 1001,
          number: 1,
          type: 'F',
          lat: [47, 36, 22.3, 'N'],
          lon: [122, 19, 55.6, 'W'],
        }),
        lo({
          usi: 1006,
          number: 1,
          type: 'F',
          lat: [45, 30, 54.7, 'N'],
          lon: [122, 40, 42.2, 'W'],
        }),
        lo({ usi: 1100, number: 1, type: 'F', lat: [47, 37, 0, 'N'], lon: [122, 20, 0, 'W'] }),
        lo({ usi: 1101, number: 1, type: 'F', lat: [47, 37, 0, 'N'], lon: [122, 20, 0, 'W'] }),
      ]),
    },
    {
      name: 'AN.dat',
      data: datFile([
        an({ usi: 1006, antenna: 1, location: 1, type: 'T' }),
        an({ usi: 1100, antenna: 1, location: 1, type: 'T' }),
      ]),
    },
    {
      name: 'FR.dat',
      data: datFile([
        fr({ usi: 1001, location: 1, antenna: 1, seq: 1, frequency: 152.24 }),
        fr({ usi: 1006, location: 1, antenna: 1, seq: 1, stationClass: 'FB2', frequency: 153.0 }),
        fr({ usi: 1100, location: 1, antenna: 1, seq: 1, stationClass: 'FB2', frequency: 152.3 }),
        fr({ usi: 1101, location: 1, antenna: 1, seq: 1, frequency: 152.3 }),
      ]),
    },
    {
      name: 'EM.dat',
      data: datFile([em({ usi: 1100, location: 1, antenna: 1, seq: 1, code: '11K2F3E' })]),
    },
  ]),
};

/** Monday's market daily: the lease 2002 and its parent 2001 re-sent whole. */
export const DAILY_MK_MON: FixtureFile = {
  countsCreated: '2026-09-28T12:02:00Z',
  lastModified: '2026-09-28T12:02:03Z',
  zip: buildZip([
    { name: 'counts', data: countsFile('Mon Sep 28 08:02:00 EDT 2026', { HD: 2, ll: 1 }) },
    {
      name: 'HD.dat',
      data: datFile([
        hd({ usi: 2001, callsign: 'KZZ801', status: 'A', service: 'BR', grant: '04/04/2014' }),
        hd({ usi: 2002, callsign: 'L000000001', status: 'A', service: 'BR', grant: '05/05/2015' }),
      ]),
    },
    {
      name: 'EN.dat',
      data: datFile([
        en({ usi: 2001, name: 'Sample Broadband Inc', state: 'ND', applicantType: 'C' }),
        en({ usi: 2002, name: 'Leaseholder Wireless LLC', state: 'MN', applicantType: 'L' }),
      ]),
    },
    {
      name: 'MK.dat',
      data: datFile([
        mk({ usi: 2001, code: 'BTA144', block: 'A1', name: 'Fargo-Moorhead, ND-MN' }),
        mk({ usi: 2002, code: 'BTA144', block: 'A1', name: 'Fargo-Moorhead, ND-MN' }),
      ]),
    },
    {
      name: 'll.dat',
      data: datFile([
        ll({ leaseUsi: 2002, parentCallsign: 'KZZ801', leaseId: 'L000000001', parentUsi: 2001 }),
      ]),
    },
    {
      name: 'LO.dat',
      data: datFile([
        lo({ usi: 2001, number: 1, type: 'F', lat: [46, 52, 38, 'N'], lon: [96, 47, 23, 'W'] }),
      ]),
    },
    {
      name: 'FR.dat',
      data: datFile([
        fr({ usi: 2001, location: 1, antenna: 1, seq: 1, frequency: 2500, upper: 2506 }),
      ]),
    },
    {
      name: 'EM.dat',
      data: datFile([em({ usi: 2001, location: 1, antenna: 1, seq: 1, code: '6M00D1D' })]),
    },
    {
      name: 'MF.dat',
      data: datFile([
        mf({ usi: 2001, partition: 1, lower: 2496, upper: 2502 }),
        mf({ usi: 2002, partition: 1, lower: 2496, upper: 2502 }),
      ]),
    },
  ]),
};

/**
 * Monday's earliest daily, wider than anything in the weekly snapshots: a new paging license
 * (1200) on a 50 MHz emission and a new BRS license (2100) with a 34 MHz market block.
 */
export const DAILY_WIDE_MON: FixtureFile = {
  countsCreated: '2026-09-28T12:00:28Z',
  lastModified: '2026-09-28T12:00:30Z',
  zip: buildZip([
    { name: 'counts', data: countsFile('Mon Sep 28 08:00:28 EDT 2026', { HD: 2 }) },
    {
      name: 'HD.dat',
      data: datFile([
        hd({ usi: 1200, callsign: 'KZZ200', status: 'A', service: 'CD', grant: '09/28/2026' }),
        hd({ usi: 2100, callsign: 'KZZ810', status: 'A', service: 'BR', grant: '09/28/2026' }),
      ]),
    },
    {
      name: 'EN.dat',
      data: datFile([
        en({ usi: 1200, name: 'Broad Emission Paging LLC', state: 'WA', applicantType: 'L' }),
        en({ usi: 2100, name: 'Wide Block Broadband Inc', state: 'ND', applicantType: 'C' }),
      ]),
    },
    {
      name: 'MK.dat',
      data: datFile([
        mk({ usi: 2100, code: 'BTA144', block: 'B1', name: 'Fargo-Moorhead, ND-MN' }),
      ]),
    },
    {
      name: 'LO.dat',
      data: datFile([
        lo({
          usi: 1200,
          number: 1,
          type: 'F',
          state: 'WA',
          lat: [47, 20, 0, 'N'],
          lon: [122, 0, 0, 'W'],
        }),
      ]),
    },
    { name: 'AN.dat', data: datFile([an({ usi: 1200, antenna: 1, location: 1, type: 'T' })]) },
    {
      name: 'FR.dat',
      data: datFile([
        fr({ usi: 1200, location: 1, antenna: 1, seq: 1, stationClass: 'FB2', frequency: 470 }),
      ]),
    },
    {
      name: 'EM.dat',
      data: datFile([em({ usi: 1200, location: 1, antenna: 1, seq: 1, code: '50M0D7W' })]),
    },
    {
      name: 'MF.dat',
      data: datFile([mf({ usi: 2100, partition: 1, lower: 2540, upper: 2574 })]),
    },
  ]),
};

/** Tuesday's paging daily: an empty day, `counts` only. */
export const DAILY_PG_TUE: FixtureFile = {
  countsCreated: '2026-09-29T12:00:05Z',
  lastModified: '2026-09-29T12:00:07Z',
  zip: buildZip([{ name: 'counts', data: countsFile('Tue Sep 29 08:00:05 EDT 2026') }]),
};

/** Sunday's paging daily, created before the weekly snapshot: never applied. */
export const DAILY_PG_SUN: FixtureFile = {
  countsCreated: '2026-09-27T12:00:00Z',
  lastModified: '2026-09-27T12:00:02Z',
  zip: buildZip([
    { name: 'counts', data: countsFile('Sun Sep 27 08:00:00 EDT 2026', { HD: 1 }) },
    {
      name: 'HD.dat',
      data: datFile([hd({ usi: 1001, callsign: 'KZZ901', status: 'T', service: 'CD' })]),
    },
  ]),
};

/**
 * A paging snapshot of carrier names joined by `-` and `&`, beside the unrelated names their
 * one-letter pieces prefix-match as separate words, and two plain multi-word names: T-Mobile
 * License LLC (USI 6001), Florida Mobile Telephone (6002), Mobile Tech Communications (6003),
 * AT&T Mobility Spectrum LLC (6004), Atlantic Telecommunications (6005), Acme Wireless Inc
 * (6006), and Acme Tower Wireless (6007). Every record is active.
 */
export function carrierNamesWeekly(): FixtureFile {
  const names = [
    'T-Mobile License LLC',
    'Florida Mobile Telephone',
    'Mobile Tech Communications',
    'AT&T Mobility Spectrum LLC',
    'Atlantic Telecommunications',
    'Acme Wireless Inc',
    'Acme Tower Wireless',
  ];
  const usis = names.map((_, i) => 6001 + i);
  return {
    countsCreated: PAGING_WEEKLY.countsCreated,
    lastModified: PAGING_WEEKLY.lastModified,
    zip: buildZip([
      {
        name: 'counts',
        data: countsFile('Sun Sep 27 09:38:53 EDT 2026', { HD: names.length, EN: names.length }),
      },
      {
        name: 'HD.dat',
        data: datFile(
          usis.map((usi) => hd({ usi, callsign: `KZZ${usi - 5400}`, status: 'A', service: 'CD' })),
        ),
      },
      {
        name: 'EN.dat',
        data: datFile(
          names.map((name, i) => en({ usi: usis[i] ?? 0, name, state: 'WA', applicantType: 'C' })),
        ),
      },
    ]),
  };
}

/** Shape of {@link sprawlingPagingWeekly}'s one large license. */
export interface SprawlOptions {
  /** Antennas filed at each location, each with one frequency row. */
  antennasPerLocation: number;
  /** Leases carved from the license. */
  leases: number;
  /** Location numbers the license files, 1 through `locations`. */
  locations: number;
  /** Sites filed under location 1; every other number has one. */
  sitesAtFirst: number;
}

/**
 * A paging snapshot whose one active license, KZZ701 (USI 7001), files `locations` location
 * numbers (location 1 at `sitesAtFirst` sites, the rest at one), `antennasPerLocation`
 * antennas at each with one frequency row apiece, and `leases` active leases L000070001…
 * (USIs 7101…), each linked to it.
 */
export function sprawlingPagingWeekly(options: SprawlOptions): FixtureFile {
  const { antennasPerLocation, leases, locations, sitesAtFirst } = options;
  const numbers = Array.from({ length: locations }, (_, i) => i + 1);
  const sites = numbers.flatMap((number) =>
    Array.from({ length: number === 1 ? sitesAtFirst : 1 }, (_, site) =>
      lo({
        usi: 7001,
        number,
        type: 'F',
        state: 'WA',
        lat: [47, number % 60, site % 60, 'N'],
        lon: [122, number % 60, site % 60, 'W'],
        name: `SITE ${number}-${site + 1}`,
      }),
    ),
  );
  const antennas = numbers.flatMap((location) =>
    Array.from({ length: antennasPerLocation }, (_, i) =>
      an({ usi: 7001, antenna: i + 1, location, type: 'T' }),
    ),
  );
  const frequencies = numbers.flatMap((location) =>
    Array.from({ length: antennasPerLocation }, (_, i) =>
      fr({
        usi: 7001,
        location,
        antenna: i + 1,
        seq: 1,
        stationClass: 'FB2',
        frequency: (150 + location * 0.0125 + i * 0.00625).toFixed(5),
      }),
    ),
  );
  const leaseUsis = Array.from({ length: leases }, (_, i) => 7101 + i);
  const leaseId = (usi: number) => `L0000${String(usi - 7100 + 70_000).padStart(5, '0')}`;
  return {
    countsCreated: PAGING_WEEKLY.countsCreated,
    lastModified: PAGING_WEEKLY.lastModified,
    zip: buildZip([
      {
        name: 'counts',
        data: countsFile('Sun Sep 27 09:38:53 EDT 2026', {
          HD: 1 + leases,
          EN: 1 + leases,
          LL: leases,
          LO: sites.length,
          AN: antennas.length,
          FR: frequencies.length,
        }),
      },
      {
        name: 'HD.dat',
        data: datFile([
          hd({ usi: 7001, callsign: 'KZZ701', status: 'A', service: 'CD', grant: '01/01/2024' }),
          ...leaseUsis.map((usi) =>
            hd({ usi, callsign: leaseId(usi), status: 'A', service: 'CD', grant: '01/01/2024' }),
          ),
        ]),
      },
      {
        name: 'EN.dat',
        data: datFile([
          en({ usi: 7001, name: 'Sprawling Paging Co', state: 'WA', applicantType: 'C' }),
          ...leaseUsis.map((usi) =>
            en({ usi, name: `Lessee ${usi}`, state: 'WA', applicantType: 'C' }),
          ),
        ]),
      },
      {
        name: 'LL.dat',
        data: datFile(
          leaseUsis.map((usi) =>
            ll({ leaseUsi: usi, parentCallsign: 'KZZ701', leaseId: leaseId(usi), parentUsi: 7001 }),
          ),
        ),
      },
      { name: 'LO.dat', data: datFile(sites) },
      { name: 'AN.dat', data: datFile(antennas) },
      { name: 'FR.dat', data: datFile(frequencies) },
    ]),
  };
}

/**
 * A paging snapshot whose one active license, KZZ401 (USI 4001), files `count` distinct
 * frequency rows on one antenna: enough to push a frequency cap to its 1000-row ceiling.
 */
export function widePagingWeekly(count: number): FixtureFile {
  const frequencies = Array.from({ length: count }, (_, i) =>
    fr({
      usi: 4001,
      location: 1,
      antenna: 1,
      seq: i + 1,
      stationClass: 'FB2',
      frequency: (150 + i * 0.0125).toFixed(4),
    }),
  );
  return {
    countsCreated: PAGING_WEEKLY.countsCreated,
    lastModified: PAGING_WEEKLY.lastModified,
    zip: buildZip([
      {
        name: 'counts',
        data: countsFile('Sun Sep 27 09:38:53 EDT 2026', { HD: 1, EN: 1, LO: 1, FR: count }),
      },
      {
        name: 'HD.dat',
        data: datFile([
          hd({ usi: 4001, callsign: 'KZZ401', status: 'A', service: 'CD', grant: '01/01/2024' }),
        ]),
      },
      {
        name: 'EN.dat',
        data: datFile([
          en({ usi: 4001, name: 'Wide Channel Paging Co', state: 'WA', applicantType: 'C' }),
        ]),
      },
      {
        name: 'LO.dat',
        data: datFile([
          lo({
            usi: 4001,
            number: 1,
            type: 'F',
            state: 'WA',
            lat: [47, 10, 0, 'N'],
            lon: [122, 10, 0, 'W'],
          }),
        ]),
      },
      { name: 'AN.dat', data: datFile([an({ usi: 4001, antenna: 1, location: 1, type: 'T' })]) },
      { name: 'FR.dat', data: datFile(frequencies) },
    ]),
  };
}

/**
 * A paging-slot snapshot of filing quirks, every record active: KZZ501 (USI 5001, TT) files a
 * 5.75 GHz emission on 470 and 638 MHz (beside a plausible 6 MHz one on 470); KZZ502 (USI
 * 5002, RS) a 24.1 GHz emission on 24150 MHz and a 1.3 GHz radar emission on 8500 MHz;
 * KZZ503 (USI 5003, PL) a Priority Access License block filed as 0–10 MHz; KZZ504 (USI
 * 5004, CW) two blocks each filed under three partition areas; KZZ505 (USI 5005, IQ) two
 * sites under location 1, one minute of longitude either side of 47-40-00 N 122-21-00 W, each
 * with an AN record for antenna 1, and the number's two frequencies filed once against it
 * (both with freq_seq_id 1), beside an ordinary single-site location 2.
 */
export const QUIRKS_WEEKLY: FixtureFile = {
  countsCreated: PAGING_WEEKLY.countsCreated,
  lastModified: PAGING_WEEKLY.lastModified,
  zip: buildZip([
    { name: 'counts', data: countsFile('Sun Sep 27 09:38:53 EDT 2026', { HD: 5, EN: 5 }) },
    {
      name: 'HD.dat',
      data: datFile([
        hd({ usi: 5001, callsign: 'KZZ501', status: 'A', service: 'TT', grant: '01/01/2020' }),
        hd({ usi: 5002, callsign: 'KZZ502', status: 'A', service: 'RS', grant: '01/01/2020' }),
        hd({ usi: 5003, callsign: 'KZZ503', status: 'A', service: 'PL', grant: '01/01/2020' }),
        hd({ usi: 5004, callsign: 'KZZ504', status: 'A', service: 'CW', grant: '01/01/2020' }),
        hd({ usi: 5005, callsign: 'KZZ505', status: 'A', service: 'IQ', grant: '01/01/2020' }),
      ]),
    },
    {
      name: 'EN.dat',
      data: datFile([
        en({ usi: 5001, name: 'Pickup Relay Broadcasting', state: 'WA', applicantType: 'C' }),
        en({ usi: 5002, name: 'Radar Survey Labs', state: 'WA', applicantType: 'C' }),
        en({ usi: 5003, name: 'Priority Access Wireless', state: 'WA', applicantType: 'C' }),
        en({ usi: 5004, name: 'Partitioned Spectrum Co', state: 'CA', applicantType: 'C' }),
        en({ usi: 5005, name: 'Roadside Signal Authority', state: 'WA', applicantType: 'G' }),
      ]),
    },
    {
      name: 'MK.dat',
      data: datFile([
        mk({ usi: 5003, code: 'CN53033', name: 'King, WA' }),
        mk({ usi: 5004, code: 'CMA097', block: 'G', name: 'Bakersfield, CA' }),
      ]),
    },
    {
      name: 'LO.dat',
      data: datFile([
        lo({ usi: 5001, number: 1, type: 'F', lat: [47, 30, 0, 'N'], lon: [122, 30, 0, 'W'] }),
        lo({ usi: 5002, number: 1, type: 'F', lat: [47, 31, 0, 'N'], lon: [122, 31, 0, 'W'] }),
        lo({
          usi: 5005,
          number: 1,
          type: 'F',
          city: 'Shoreline',
          county: 'King',
          state: 'WA',
          groundElevation: 120,
          lat: [47, 40, 0, 'N'],
          lon: [122, 22, 0, 'W'],
          supportHeight: 9.8,
          overallHeight: 10.4,
          structureType: 'POLE',
          name: '33 SR99 North Rd',
        }),
        lo({
          usi: 5005,
          number: 1,
          type: 'F',
          city: 'Seattle',
          county: 'King',
          state: 'WA',
          groundElevation: 60,
          lat: [47, 40, 0, 'N'],
          lon: [122, 20, 0, 'W'],
          supportHeight: 6.7,
          overallHeight: 6.7,
          structureType: 'POLE',
          name: '35 I5 Northgate',
        }),
        lo({
          usi: 5005,
          number: 2,
          type: 'F',
          city: 'Bellevue',
          county: 'King',
          state: 'WA',
          groundElevation: 40,
          lat: [47, 36, 0, 'N'],
          lon: [122, 12, 0, 'W'],
          overallHeight: 15,
          structureType: 'TOWER',
          name: 'Single Site',
        }),
      ]),
    },
    {
      name: 'AN.dat',
      data: datFile([
        an({ usi: 5001, antenna: 1, location: 1, type: 'T' }),
        an({ usi: 5002, antenna: 1, location: 1, type: 'T' }),
        ...[7.9, 5.8].map((heightToTip) =>
          an({
            usi: 5005,
            antenna: 1,
            location: 1,
            type: 'T',
            heightToTip,
            make: 'GTTEU',
            model: 'OA-59',
            gain: 7.6,
            azimuth: 360,
          }),
        ),
        an({
          usi: 5005,
          antenna: 1,
          location: 2,
          type: 'T',
          heightToTip: 15,
          make: 'ACME',
          model: 'X1',
          gain: 9,
        }),
      ]),
    },
    {
      name: 'FR.dat',
      data: datFile([
        fr({ usi: 5001, location: 1, antenna: 1, seq: 1, frequency: 470 }),
        fr({ usi: 5001, location: 1, antenna: 1, seq: 2, frequency: 638 }),
        fr({ usi: 5002, location: 1, antenna: 1, seq: 1, frequency: 24150 }),
        fr({ usi: 5002, location: 1, antenna: 1, seq: 2, frequency: 8500 }),
        ...[5895, 5915].map((frequency) =>
          fr({
            usi: 5005,
            location: 1,
            antenna: 1,
            seq: 1,
            stationClass: 'FB',
            frequency,
            upper: frequency + 10,
            eirp: 23,
          }),
        ),
        fr({
          usi: 5005,
          location: 2,
          antenna: 1,
          seq: 1,
          stationClass: 'FB',
          frequency: 5935,
          upper: 5945,
          eirp: 20,
        }),
      ]),
    },
    {
      name: 'EM.dat',
      data: datFile([
        em({ usi: 5001, location: 1, antenna: 1, seq: 1, code: '5G75C3F' }),
        em({ usi: 5001, location: 1, antenna: 1, seq: 1, code: '6M00C3F' }),
        em({ usi: 5001, location: 1, antenna: 1, seq: 2, code: '5G75C3F' }),
        em({ usi: 5002, location: 1, antenna: 1, seq: 1, code: '24G1N0N' }),
        em({ usi: 5002, location: 1, antenna: 1, seq: 2, code: '1G30NXN' }),
      ]),
    },
    {
      name: 'MF.dat',
      data: datFile([
        mf({ usi: 5003, partition: 41001, lower: 0, upper: 10 }),
        ...[8183, 8184, 96978].flatMap((partition) => [
          mf({ usi: 5004, partition, lower: 1755, upper: 1760 }),
          mf({ usi: 5004, partition, lower: 2155, upper: 2160 }),
        ]),
      ]),
    },
  ]),
};

/**
 * A paging-slot snapshot of occupied widths at and past the band-class ceilings, every record
 * active: KZZ601 (USI 6001, CD) files 100 MHz on a 62.5 kHz emission (exactly 2^-4 MHz wide),
 * 200 MHz on a 62.6 kHz one (just past it), 300 MHz with no emission (zero width), 400 MHz
 * with its upper edge filed below it at 350 MHz on a 16 kHz emission (an inverted range), and
 * 9000 MHz on a 1.6 GHz radar emission (8200–9800 MHz); KZZ602 (USI 6002, RS) a 1000–20000 MHz
 * range, wider than the largest power-of-two class; KZZ603 (USI 6003, CW) a 700–700.5 MHz
 * market block (exactly 2^-1 MHz) and a 10000–20000 MHz one.
 */
export const BAND_CLASS_WEEKLY: FixtureFile = {
  countsCreated: PAGING_WEEKLY.countsCreated,
  lastModified: PAGING_WEEKLY.lastModified,
  zip: buildZip([
    { name: 'counts', data: countsFile('Sun Sep 27 09:38:53 EDT 2026', { HD: 3, EN: 3 }) },
    {
      name: 'HD.dat',
      data: datFile([
        hd({ usi: 6001, callsign: 'KZZ601', status: 'A', service: 'CD', grant: '01/01/2020' }),
        hd({ usi: 6002, callsign: 'KZZ602', status: 'A', service: 'RS', grant: '01/01/2020' }),
        hd({ usi: 6003, callsign: 'KZZ603', status: 'A', service: 'CW', grant: '01/01/2020' }),
      ]),
    },
    {
      name: 'EN.dat',
      data: datFile([
        en({ usi: 6001, name: 'Class Ceiling Paging', state: 'WA', applicantType: 'C' }),
        en({ usi: 6002, name: 'Broad Range Survey', state: 'WA', applicantType: 'C' }),
        en({ usi: 6003, name: 'Block Edge Wireless', state: 'WA', applicantType: 'C' }),
      ]),
    },
    { name: 'MK.dat', data: datFile([mk({ usi: 6003, code: 'CMA001', name: 'Seattle, WA' })]) },
    {
      name: 'LO.dat',
      data: datFile([
        lo({ usi: 6001, number: 1, type: 'F', lat: [47, 32, 0, 'N'], lon: [122, 32, 0, 'W'] }),
        lo({ usi: 6002, number: 1, type: 'F', lat: [47, 33, 0, 'N'], lon: [122, 33, 0, 'W'] }),
      ]),
    },
    {
      name: 'AN.dat',
      data: datFile([
        an({ usi: 6001, antenna: 1, location: 1, type: 'T' }),
        an({ usi: 6002, antenna: 1, location: 1, type: 'T' }),
      ]),
    },
    {
      name: 'FR.dat',
      data: datFile([
        ...[100, 200, 300, 9000].map((frequency, i) =>
          fr({ usi: 6001, location: 1, antenna: 1, seq: i + 1, frequency }),
        ),
        fr({ usi: 6001, location: 1, antenna: 1, seq: 5, frequency: 400, upper: 350 }),
        fr({ usi: 6002, location: 1, antenna: 1, seq: 1, frequency: 1000, upper: 20000 }),
      ]),
    },
    {
      name: 'EM.dat',
      data: datFile([
        em({ usi: 6001, location: 1, antenna: 1, seq: 1, code: '62K5F3E' }),
        em({ usi: 6001, location: 1, antenna: 1, seq: 2, code: '62K6F3E' }),
        em({ usi: 6001, location: 1, antenna: 1, seq: 4, code: '1G60N0N' }),
        em({ usi: 6001, location: 1, antenna: 1, seq: 5, code: '16K0F3E' }),
      ]),
    },
    {
      name: 'MF.dat',
      data: datFile([
        mf({ usi: 6003, partition: 1, lower: 700, upper: 700.5 }),
        mf({ usi: 6003, partition: 1, lower: 10000, upper: 20000 }),
      ]),
    },
  ]),
};

/** The fixture weekly snapshot of each group. */
export const WEEKLY_FIXTURES = {
  paging: PAGING_WEEKLY,
  mdsitfs: MDSITFS_WEEKLY,
  amat: AMAT_WEEKLY,
} as const;

// --- Fake bulk client --------------------------------------------------------------------

/** One call the fake client received. */
export interface FakeClientCall {
  method: 'download' | 'head' | 'list';
  path?: string;
}

/**
 * In-memory `IngestClient`: serves registered zips by path, records every call, and fails
 * downloads named in `failDownloads` with a transient `ServiceUnavailable`.
 */
export class FakeIngestClient implements IngestClient {
  readonly calls: FakeClientCall[] = [];
  readonly failDownloads = new Set<string>();
  daily: string[] = [];
  private readonly files = new Map<string, FixtureFile>();

  /** Serve `file` at `path` (`complete/l_paging.zip`, `daily/l_pg_mon.zip`). */
  set(path: string, file: FixtureFile): this {
    this.files.set(path, file);
    return this;
  }

  /** Serve the weekly fixtures of `groups` at their `complete/` paths. */
  withWeekly(groups: readonly (keyof typeof WEEKLY_FIXTURES)[]): this {
    for (const group of groups) this.set(`complete/l_${group}.zip`, WEEKLY_FIXTURES[group]);
    return this;
  }

  /** Serve daily files and list them in the `daily/` listing. */
  withDaily(files: Record<string, FixtureFile>): this {
    for (const [name, file] of Object.entries(files)) this.set(`daily/${name}`, file);
    this.daily = Object.keys(files);
    return this;
  }

  /** Downloads of `path` so far. */
  downloads(path: string): number {
    return this.calls.filter((call) => call.method === 'download' && call.path === path).length;
  }

  async head(path: string): Promise<UlsRemoteFile | null> {
    this.calls.push({ method: 'head', path });
    const file = this.files.get(path);
    return file ? { path, lastModified: file.lastModified, sizeBytes: file.zip.length } : null;
  }

  async download(path: string, destination: string): Promise<UlsDownload> {
    this.calls.push({ method: 'download', path });
    const file = this.files.get(path);
    if (!file || this.failDownloads.has(path)) {
      throw serviceUnavailable(`Fake download of ${path} failed.`, { path });
    }
    await writeFile(destination, file.zip);
    return {
      path,
      destination,
      lastModified: file.lastModified,
      sizeBytes: file.zip.length,
      fetchedAt: '2026-09-29T20:00:00Z',
    };
  }

  async listDailyFiles(): Promise<string[]> {
    this.calls.push({ method: 'list' });
    return [...this.daily];
  }
}

/** Epoch ms of an ISO 8601 time. */
export const at = (iso: string): number => Date.parse(iso);
