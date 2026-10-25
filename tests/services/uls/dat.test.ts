/**
 * @fileoverview Tests for ULS `.dat` parsing: UTF-8 line streaming, field-count-checked
 * splitting, field helpers, the DMS coordinate rule, emission bandwidth, the `counts`
 * header, and every record decoder.
 * @module tests/services/uls/dat.test
 */

import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { describe, expect, it } from 'vitest';
import {
  coordinateFields,
  dateField,
  decodeAm,
  decodeAn,
  decodeEm,
  decodeEn,
  decodeFr,
  decodeHd,
  decodeLl,
  decodeLo,
  decodeMf,
  decodeMk,
  decodePa,
  emissionBandwidthMhz,
  MAX_LINE_LENGTH,
  numberField,
  parseCountsFile,
  parseUlsDate,
  RECORD_FIELD_COUNTS,
  readLines,
  splitRecord,
  textField,
  toIsoSeconds,
} from '@/services/uls/dat.js';
import {
  am,
  an,
  countsFile,
  em,
  en,
  fr,
  hd,
  ll,
  lo,
  mf,
  mk,
  pa,
  record,
} from '../../fixtures/uls-fixtures.js';

async function* chunks(...parts: (string | Uint8Array)[]): AsyncGenerator<Uint8Array> {
  for (const part of parts) yield typeof part === 'string' ? Buffer.from(part, 'utf8') : part;
}

async function collect(source: AsyncIterable<Uint8Array>): Promise<string[]> {
  const lines: string[] = [];
  for await (const line of readLines(source)) lines.push(line);
  return lines;
}

describe('readLines', () => {
  it('splits on LF, strips one trailing CR, and skips blank lines', async () => {
    await expect(collect(chunks('HD|1\r\n\r\nHD|2\r\n\nHD|3'))).resolves.toEqual([
      'HD|1',
      'HD|2',
      'HD|3',
    ]);
  });

  it('joins a line split across chunks', async () => {
    await expect(collect(chunks('HD|1|par', 'tial\r', '\nHD|2\r\n'))).resolves.toEqual([
      'HD|1|partial',
      'HD|2',
    ]);
  });

  it('decodes a multibyte UTF-8 sequence split across chunks', async () => {
    const bytes = Buffer.from('EN|AÑASCO, PR\r\n', 'utf8');
    const split = bytes.indexOf(0xc3) + 1;
    await expect(collect(chunks(bytes.subarray(0, split), bytes.subarray(split)))).resolves.toEqual(
      ['EN|AÑASCO, PR'],
    );
  });

  it('replaces malformed bytes with U+FFFD instead of failing the file', async () => {
    const bytes = Buffer.concat([
      Buffer.from('EN|A'),
      Buffer.from([0xff, 0xfe]),
      Buffer.from('B\n'),
    ]);
    await expect(collect(chunks(bytes))).resolves.toEqual(['EN|A��B']);
  });

  it('keeps an inner carriage return, stripping only the trailing one', async () => {
    await expect(collect(chunks('EN|A\rB\r\n'))).resolves.toEqual(['EN|A\rB']);
  });

  it('yields nothing for an empty source', async () => {
    await expect(collect(chunks())).resolves.toEqual([]);
  });

  describe('line length ceiling', () => {
    const atMax = 'x'.repeat(MAX_LINE_LENGTH);
    const tooLong = {
      code: JsonRpcErrorCode.SerializationError,
      message: `A line longer than ${MAX_LINE_LENGTH} characters is not a ULS record.`,
      data: { maxLength: MAX_LINE_LENGTH },
    };

    it('accepts a line of exactly the ceiling, its CRLF split across chunks', async () => {
      await expect(collect(chunks(`${atMax}\r`, '\nHD|2\n'))).resolves.toEqual([atMax, 'HD|2']);
    });

    it('rejects a longer line inside one chunk', async () => {
      await expect(collect(chunks(`HD|1\n${atMax}x\nHD|3\n`))).rejects.toMatchObject(tooLong);
    });

    it('rejects a longer line split across chunks', async () => {
      await expect(collect(chunks(atMax, 'xx\n'))).rejects.toMatchObject(tooLong);
      await expect(collect(chunks(atMax, 'xx', '\n'))).rejects.toMatchObject(tooLong);
    });

    it('rejects a longer unterminated last line', async () => {
      await expect(collect(chunks(`HD|1\n${atMax}x`))).rejects.toMatchObject(tooLong);
    });

    it('stops reading a source that never sends a newline', async () => {
      let pulls = 0;
      async function* endless(): AsyncGenerator<Uint8Array> {
        const block = Buffer.alloc(4096, 'x');
        while (true) {
          pulls++;
          yield block;
        }
      }
      await expect(collect(endless())).rejects.toMatchObject(tooLong);
      expect(pulls).toBeLessThanOrEqual(MAX_LINE_LENGTH / 4096 + 2);
    });
  });
});

describe('splitRecord and field helpers', () => {
  it('splits a line of the right type and field count', () => {
    const fields = splitRecord(record('LL', { 2: 5, 7: 9 }), 'LL');
    expect(fields).toHaveLength(RECORD_FIELD_COUNTS.LL);
    expect(fields?.[0]).toBe('LL');
  });

  it('rejects a wrong field count or a line of another type', () => {
    expect(splitRecord('LL|1|2|3', 'LL')).toBeNull();
    expect(splitRecord(`${record('LL', { 2: 1 })}|extra`, 'LL')).toBeNull();
    expect(splitRecord(record('LL', { 2: 1 }), 'HD')).toBeNull();
    expect(splitRecord(record('EN', { 2: 1 }).replace(/^EN/, 'XX'), 'EN')).toBeNull();
  });

  it('reads trimmed text, finite numbers, and ISO dates, with empty as null', () => {
    const fields = ['HD', '  42 ', '', 'abc', 'Infinity', '12/31/2025', '2025-12-31', ' 1e3 '];
    expect(textField(fields, 2)).toBe('42');
    expect(textField(fields, 3)).toBeNull();
    expect(textField(fields, 99)).toBeNull();
    expect(numberField(fields, 2)).toBe(42);
    expect(numberField(fields, 3)).toBeNull();
    expect(numberField(fields, 4)).toBeNull();
    expect(numberField(fields, 5)).toBeNull();
    expect(numberField(fields, 8)).toBe(1000);
    expect(dateField(fields, 6)).toBe('2025-12-31');
    expect(dateField(fields, 7)).toBeNull();
    expect(dateField(fields, 3)).toBeNull();
  });

  it('converts only the MM/DD/YYYY date form', () => {
    expect(parseUlsDate('01/02/2003')).toBe('2003-01-02');
    expect(parseUlsDate('1/2/2003')).toBeNull();
    expect(parseUlsDate(null)).toBeNull();
    expect(parseUlsDate('')).toBeNull();
  });
});

describe('coordinateFields', () => {
  const at = (...parts: string[]) => ['LO', ...parts];

  it('decodes a complete DMS group and keeps the filed text', () => {
    expect(coordinateFields(at('47', '37', '13.8', 'N'), 2, 'latitude')).toEqual({
      decimal: 47 + 37 / 60 + 13.8 / 3600,
      dms: '47-37-13.8 N',
    });
  });

  it('parses seconds given as a bare fraction', () => {
    expect(coordinateFields(at('10', '0', '.3', 'S'), 2, 'latitude').decimal).toBeCloseTo(
      -(10 + 0.3 / 3600),
      9,
    );
  });

  it('keeps the text but drops the decimal when a part is invalid or missing', () => {
    expect(coordinateFields(at('47', '61', '0', 'N'), 2, 'latitude')).toEqual({
      decimal: null,
      dms: '47-61-0 N',
    });
    expect(coordinateFields(at('47', '', '5', 'N'), 2, 'latitude')).toEqual({
      decimal: null,
      dms: '47--5 N',
    });
    expect(coordinateFields(at('47', '1', '5', ''), 2, 'latitude')).toEqual({
      decimal: null,
      dms: '47-1-5',
    });
  });

  it('reports no text when only a hemisphere letter is filed', () => {
    expect(coordinateFields(at('', '', '', 'N'), 2, 'latitude')).toEqual({
      decimal: null,
      dms: null,
    });
  });
});

describe('emissionBandwidthMhz', () => {
  it.each([
    ['6M00D1D', 6],
    ['11K2F3E', 0.0112],
    ['16K0F3E', 0.016],
    ['20K0F1D', 0.02],
    ['5M50G7W', 5.5],
    ['100HA1A', 0.0001],
    ['1G00F9W', 1000],
    ['11k2f3e', 0.0112],
    ['K100F3E', 0.0001],
    ['250KF3E', 0.25],
  ])('parses %s as %d MHz', (designator, mhz) => {
    expect(emissionBandwidthMhz(designator)).toBeCloseTo(mhz, 12);
  });

  it.each(['XYZ', '', '6M0', '12345', 'MMMM', '6Q00D1D', '1M0'])(
    'returns null for the unparseable designator "%s"',
    (designator) => {
      expect(emissionBandwidthMhz(designator)).toBeNull();
    },
  );
});

describe('parseCountsFile', () => {
  it('converts an EDT header to UTC and strips the file paths', () => {
    expect(
      parseCountsFile(countsFile('Sun Sep 27 09:38:53 EDT 2026', { HD: 9604, ll: 441 })),
    ).toEqual({ createdAt: '2026-09-27T13:38:53Z', counts: { HD: 9604, LL: 441 } });
  });

  it('converts an EST header, rolling the date over midnight', () => {
    expect(parseCountsFile('File Creation Date: Sat Jan  3 21:30:00 EST 2026\n').createdAt).toBe(
      '2026-01-04T02:30:00Z',
    );
  });

  it('skips lines that are not count lines', () => {
    const text = 'File Creation Date: Sun Sep 27 09:38:53 EDT 2026\ngarbage\n12 EN.dat\n';
    expect(parseCountsFile(text).counts).toEqual({ EN: 12 });
  });

  it.each([
    ['an unknown time zone', 'File Creation Date: Sun Sep 27 09:38:53 PDT 2026'],
    ['an unknown month', 'File Creation Date: Sun Sop 27 09:38:53 EDT 2026'],
    ['a missing header', '12 /x/HD.dat'],
    ['an empty file', ''],
  ])('throws SerializationError on %s', (_label, text) => {
    expect(() => parseCountsFile(text)).toThrow(
      expect.objectContaining({ code: JsonRpcErrorCode.SerializationError }),
    );
  });

  it('formats epoch milliseconds without fractional seconds', () => {
    expect(toIsoSeconds(Date.UTC(2026, 8, 27, 13, 38, 53, 999))).toBe('2026-09-27T13:38:53Z');
  });
});

describe('record decoders', () => {
  it('preserves valid zero on only one coordinate axis', () => {
    for (const [lat, lon] of [
      [0, 10],
      [10, 0],
    ]) {
      expect(
        decodeLo(lo({ usi: 1, number: 1, lat: [lat!, 0, 0, 'N'], lon: [lon!, 0, 0, 'E'] })),
      ).toMatchObject({ latitude: lat, longitude: lon });
    }
  });

  it.each([
    ['N', 'E'],
    ['N', 'W'],
    ['S', 'E'],
    ['S', 'W'],
  ] as const)('drops the all-zero coordinate placeholder %s/%s', (north, east) => {
    expect(
      decodeLo(lo({ usi: 1, number: 1, state: 'NY', lat: [0, 0, 0, north], lon: [0, 0, 0, east] })),
    ).toMatchObject({
      latitude: null,
      longitude: null,
      state: 'NY',
      coordinatesDms: `0-0-0 ${north} 0-0-0 ${east}`,
    });
  });

  it('keeps unnumbered AN records but rejects malformed nonblank numbers', () => {
    expect(decodeAn(record('AN', { 2: 1, 8: 2, 10: 'R', 14: 'SuperQuad CRS4' }))).toMatchObject({
      antennaNumber: null,
      locationNumber: 2,
      antennaTypeCode: 'R',
      model: 'SuperQuad CRS4',
    });
    expect(decodeAn(record('AN', { 2: 1, 7: 'bad', 8: 2 }))).toBeNull();
  });
  it('decodes HD with ISO dates and nulls for blanks', () => {
    expect(
      decodeHd(
        hd({
          usi: 7,
          callsign: 'KZZ1',
          status: 'A',
          service: 'CD',
          grant: '03/01/2021',
          effective: '03/02/2021',
        }),
      ),
    ).toEqual({
      usi: 7,
      callsign: 'KZZ1',
      licenseStatus: 'A',
      radioServiceCode: 'CD',
      grantDate: '2021-03-01',
      expiredDate: null,
      cancellationDate: null,
      effectiveDate: '2021-03-02',
      lastActionDate: null,
    });
  });

  it('keeps an HD line without status for the ingester to reject, and rejects one without a USI', () => {
    expect(decodeHd(hd({ usi: 7 }))?.licenseStatus).toBeNull();
    expect(decodeHd(record('HD', { 5: 'KZZ1' }))).toBeNull();
    expect(decodeHd(record('HD', { 2: 'abc' }))).toBeNull();
    expect(decodeHd('HD|1|2')).toBeNull();
  });

  it('decodes only the permitted EN fields, keeping only whether name parts are filed', () => {
    const decoded = decodeEn(
      en({
        usi: 8,
        name: 'Example Co',
        first: 'Privatefirst',
        last: 'Privatelast',
        city: 'SEATTLE',
        state: 'WA',
        frn: '0001234567',
        applicantType: 'C',
        street: '1 Private Way',
        phone: '2065550100',
        email: 'x@example.test',
        zip: '98101',
      }),
    );
    expect(decoded).toEqual({
      usi: 8,
      entityType: 'L',
      entityName: 'Example Co',
      hasNameParts: true,
      city: 'SEATTLE',
      state: 'WA',
      frn: '0001234567',
      applicantType: 'C',
    });
    expect(JSON.stringify(decoded)).not.toMatch(/Private|2065550100|example\.test|98101/);
  });

  it.each([
    ['first name', { first: 'A' }],
    ['middle initial', { mi: 'Q' }],
    ['last name', { last: 'B' }],
    ['suffix', { suffix: 'JR' }],
  ])('reports name parts when only the %s is filed', (_label, parts) => {
    expect(decodeEn(en({ usi: 9, name: 'X', ...parts }))?.hasNameParts).toBe(true);
  });

  it('reports no name parts when all four are blank or whitespace', () => {
    expect(decodeEn(en({ usi: 9, name: 'X' }))?.hasNameParts).toBe(false);
    expect(
      decodeEn(en({ usi: 9, name: 'X', first: ' ', mi: ' ', last: ' ', suffix: ' ' }))
        ?.hasNameParts,
    ).toBe(false);
  });

  it('decodes AM and LL, requiring both LL USIs', () => {
    expect(
      decodeAm(am({ usi: 3, operatorClass: 'E', trusteeCallsign: 'KZ1', trusteeName: 'T P' })),
    ).toEqual({
      usi: 3,
      operatorClass: 'E',
      trusteeCallsign: 'KZ1',
      previousCallsign: null,
      trusteeName: 'T P',
    });
    expect(
      decodeLl(ll({ leaseUsi: 2, parentCallsign: 'KZZ1', leaseId: 'L000000001', parentUsi: 1 })),
    ).toEqual({ leaseUsi: 2, parentCallsign: 'KZZ1', leaseId: 'L000000001', parentUsi: 1 });
    expect(decodeLl(record('LL', { 2: 2 }))).toBeNull();
  });

  it('decodes LO with decimals only when both axes pass, always keeping the DMS text', () => {
    const good = decodeLo(
      lo({
        usi: 1,
        number: 2,
        type: 'F',
        state: 'WA',
        groundElevation: 50.3,
        lat: [47, 36, 22.3, 'N'],
        lon: [122, 19, 55.6, 'W'],
        asr: '1012345',
        overallHeight: 45.5,
      }),
    );
    expect(good).toMatchObject({
      usi: 1,
      locationNumber: 2,
      locationTypeCode: 'F',
      state: 'WA',
      groundElevationM: 50.3,
      coordinatesDms: '47-36-22.3 N 122-19-55.6 W',
      asrNumber: '1012345',
      overallHeightM: 45.5,
    });
    expect(good?.latitude).toBeCloseTo(47.606194, 5);
    expect(good?.longitude).toBeCloseTo(-122.332111, 5);

    const halfBad = decodeLo(
      lo({ usi: 1, number: 1, lat: [43, 61, 0, 'N'], lon: [116, 12, 0, 'W'] }),
    );
    expect(halfBad).toMatchObject({
      latitude: null,
      longitude: null,
      coordinatesDms: '43-61-0 N 116-12-0 W',
    });

    const none = decodeLo(lo({ usi: 1, number: 1 }));
    expect(none).toMatchObject({ latitude: null, longitude: null, coordinatesDms: null });
    expect(decodeLo(record('LO', { 2: 1 }))).toBeNull();
  });

  it('decodes AN, FR, and EM, requiring their key fields', () => {
    expect(
      decodeAn(an({ usi: 1, antenna: 2, location: 3, gain: 6.1, make: 'ANTCO' })),
    ).toMatchObject({
      usi: 1,
      antennaNumber: 2,
      locationNumber: 3,
      gainDbi: 6.1,
      make: 'ANTCO',
      azimuthDeg: null,
    });
    expect(decodeAn(record('AN', { 2: 1, 7: 2 }))).toBeNull();

    expect(
      decodeFr(fr({ usi: 1, location: 1, antenna: 1, seq: 4, frequency: 152.24, erp: 250 })),
    ).toMatchObject({ usi: 1, freqSeqId: 4, frequencyMhz: 152.24, erpW: 250, upperMhz: null });
    expect(decodeFr(fr({ usi: 1, location: 1, antenna: 1, seq: 4 }))?.frequencyMhz).toBeNull();
    expect(decodeFr(record('FR', { 2: 1, 7: 1, 8: 1 }))).toBeNull();

    expect(decodeEm(em({ usi: 1, location: 1, antenna: 1, seq: 4, code: '11K2F3E' }))).toEqual({
      usi: 1,
      locationNumber: 1,
      antennaNumber: 1,
      frequencyMhz: null,
      emissionCode: '11K2F3E',
      freqSeqId: 4,
    });
    expect(decodeEm(record('EM', { 2: 1, 6: 1, 7: 1, 13: 4 }))).toBeNull();
  });

  it('decodes MK and MF, keeping a blank MF partition area as null', () => {
    expect(
      decodeMk(mk({ usi: 1, code: 'BTA138', block: 'A1', name: 'Fargo-Moorhead, ND-MN' })),
    ).toEqual({
      usi: 1,
      marketCode: 'BTA138',
      channelBlock: 'A1',
      marketName: 'Fargo-Moorhead, ND-MN',
    });
    expect(decodeMf(mf({ usi: 1, lower: 2502, upper: 2508 }))).toEqual({
      usi: 1,
      partitionAreaId: null,
      lowerMhz: 2502,
      upperMhz: 2508,
    });
    expect(decodeMf(record('MF', { 2: 1, 8: 2508 }))).toBeNull();
  });

  describe('decodePa', () => {
    /** A path line as ULS ships it: the layout's 22 fields plus two empty ones. */
    const filed = 'PA|9001|||KZZ920||3|1|3|2|1||Fixed Point-to-Point|N|||KZZ930|||||||';
    const base = { usi: 1, path: 2, txLocation: 1, txAntenna: 4, rxLocation: 5 } as const;

    it('reads a 24-field line at the layout positions', () => {
      expect(filed.split('|')).toHaveLength(RECORD_FIELD_COUNTS.PA);
      expect(decodePa(filed)).toEqual({
        usi: 9001,
        pathNumber: 3,
        transmitLocationNumber: 1,
        transmitAntennaNumber: 3,
        receiveLocationNumber: 2,
        receiveAntennaNumber: 1,
        pathTypeCode: 'Fixed Point-to-Point',
        passiveReceiver: false,
        receiverCallsign: 'KZZ930',
      });
    });

    it('rejects a line of the published 22-field layout length', () => {
      expect(decodePa(filed.split('|').slice(0, 22).join('|'))).toBeNull();
    });

    it('keeps a blank receive antenna, path type, passive flag, and receiver as null', () => {
      expect(decodePa(pa(base))).toEqual({
        usi: 1,
        pathNumber: 2,
        transmitLocationNumber: 1,
        transmitAntennaNumber: 4,
        receiveLocationNumber: 5,
        receiveAntennaNumber: null,
        pathTypeCode: null,
        passiveReceiver: null,
        receiverCallsign: null,
      });
    });

    it.each([
      ['Y', true],
      ['y', true],
      ['N', false],
      ['X', null],
    ] as const)('reads passive receiver %s as %s', (passive, expected) => {
      expect(decodePa(pa({ ...base, passive }))?.passiveReceiver).toBe(expected);
    });

    it('keeps the receiver callsign as filed, trimmed', () => {
      expect(decodePa(pa({ ...base, receiver: ' NEW CALL ' }))?.receiverCallsign).toBe('NEW CALL');
      expect(decodePa(pa({ ...base, receiver: 'wqid205' }))?.receiverCallsign).toBe('wqid205');
    });

    it.each([
      ['USI', 2],
      ['path number', 7],
      ['transmit location', 8],
      ['transmit antenna', 9],
      ['receive location', 10],
    ])('rejects a line whose %s is blank or not a number', (_label, position) => {
      const fields = filed.split('|');
      for (const value of ['', '3a']) {
        fields[position - 1] = value;
        expect(decodePa(fields.join('|'))).toBeNull();
      }
    });

    it('rejects a filed receive antenna that is not a number', () => {
      const fields = filed.split('|');
      fields[10] = 'R1';
      expect(decodePa(fields.join('|'))).toBeNull();
    });
  });
});
