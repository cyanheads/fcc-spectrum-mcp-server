/**
 * @fileoverview Tests for the streaming ZIP reader: stored and DEFLATE entries, name
 * lookup, line and text reads, header quirks it must tolerate, and every archive shape it
 * must refuse (unsupported method, encryption, ZIP64, multi-disk, truncated or corrupt).
 * @module tests/services/uls/zip-reader.test
 */

import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openZipArchive, type ZipArchive } from '@/services/uls/zip-reader.js';
import {
  buildZip,
  datFile,
  type ZipEntrySpec,
  type ZipOptions,
} from '../../fixtures/uls-fixtures.js';

let dir: string;
const open: ZipArchive[] = [];

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'fcc-zip-reader-'));
});

afterEach(async () => {
  await Promise.all(open.splice(0).map((archive) => archive.close()));
  await rm(dir, { recursive: true, force: true });
});

/** Write `bytes` to a temp file and return its path. */
async function writeArchive(bytes: Uint8Array, name = 'a.zip'): Promise<string> {
  const path = join(dir, name);
  await writeFile(path, bytes);
  return path;
}

/** Build, write, and open an archive. */
async function openBuilt(
  entries: readonly ZipEntrySpec[],
  options?: ZipOptions,
): Promise<ZipArchive> {
  const archive = await openZipArchive(await writeArchive(buildZip(entries, options)));
  open.push(archive);
  return archive;
}

/** Expect opening `bytes` to fail with a SerializationError whose message matches `pattern`. */
async function expectOpenRefusal(bytes: Uint8Array, pattern: RegExp): Promise<void> {
  const path = await writeArchive(bytes);
  await expect(openZipArchive(path)).rejects.toMatchObject({
    code: JsonRpcErrorCode.SerializationError,
    message: expect.stringMatching(pattern),
  });
}

async function collect(lines: AsyncIterable<string>): Promise<string[]> {
  const out: string[] = [];
  for await (const line of lines) out.push(line);
  return out;
}

describe('reading entries', () => {
  it('reads deflated and stored entries back byte for byte', async () => {
    const archive = await openBuilt([
      { name: 'HD.dat', data: 'deflated text\n'.repeat(500), method: 'deflate' },
      { name: 'counts', data: 'stored text', method: 'store' },
    ]);
    expect(archive.entries.map((entry) => [entry.name, entry.method])).toEqual([
      ['HD.dat', 8],
      ['counts', 0],
    ]);
    const hd = archive.find('HD.dat');
    const counts = archive.find('counts');
    expect(await archive.readText(hd as NonNullable<typeof hd>)).toBe(
      'deflated text\n'.repeat(500),
    );
    expect(await archive.readText(counts as NonNullable<typeof counts>)).toBe('stored text');
  });

  it('reports sizes and the file path', async () => {
    const archive = await openBuilt([{ name: 'a.dat', data: 'x'.repeat(1000) }]);
    const entry = archive.entries[0];
    expect(entry?.uncompressedSize).toBe(1000);
    expect(entry?.compressedSize).toBeLessThan(1000);
    expect(archive.path).toBe(join(dir, 'a.zip'));
  });

  it('finds an entry case-insensitively and returns undefined for a miss', async () => {
    const archive = await openBuilt([
      { name: 'HD.dat', data: 'a' },
      { name: 'll.dat', data: 'b' },
    ]);
    expect(archive.find('ll.dat')?.name).toBe('ll.dat');
    expect(archive.find('LL.DAT')?.name).toBe('ll.dat');
    expect(archive.find('hd.DAT')?.name).toBe('HD.dat');
    expect(archive.find('missing.dat')).toBeUndefined();
  });

  it('decodes names as UTF-8 only when the flag is set, otherwise as Latin-1', async () => {
    const archive = await openBuilt([
      { name: 'é.dat', data: 'a', flags: 0x800 },
      { name: 'ü.dat', data: 'b' },
    ]);
    expect(archive.find('é.dat')).toBeDefined();
    expect(archive.find('ü.dat')).toBeUndefined();
    expect(archive.entries[1]?.name).toBe(Buffer.from('ü.dat', 'utf8').toString('latin1'));
  });

  it('streams lines with CRLF endings stripped and empty lines skipped', async () => {
    const archive = await openBuilt([
      { name: 'EN.dat', data: `${datFile(['EN|1|a', 'EN|2|b'])}\r\n${datFile(['EN|3|c'])}` },
    ]);
    const entry = archive.find('en.dat') as NonNullable<ReturnType<ZipArchive['find']>>;
    expect(await collect(archive.entryLines(entry))).toEqual(['EN|1|a', 'EN|2|b', 'EN|3|c']);
  });

  it('keeps multibyte text intact across a deflated entry', async () => {
    const archive = await openBuilt([{ name: 'EN.dat', data: datFile(['EN|1|Ünïcode | Paging']) }]);
    const entry = archive.entries[0] as NonNullable<(typeof archive.entries)[number]>;
    expect(await collect(archive.entryLines(entry))).toEqual(['EN|1|Ünïcode | Paging']);
  });

  it('yields nothing for empty entries, stored or deflated', async () => {
    const archive = await openBuilt([
      { name: 'stored-empty', data: '', method: 'store' },
      { name: 'deflated-empty', data: '', method: 'deflate' },
    ]);
    for (const entry of archive.entries) {
      expect(await archive.readText(entry)).toBe('');
      expect(await collect(archive.entryLines(entry))).toEqual([]);
    }
    expect(archive.entries[0]?.compressedSize).toBe(0);
  });

  it('skips a local extra field longer than the central one', async () => {
    const archive = await openBuilt([
      { name: 'a.dat', data: 'first entry', localExtra: 37 },
      { name: 'b.dat', data: 'second entry', method: 'store', localExtra: 300 },
    ]);
    expect(await archive.readText(archive.entries[0] as never)).toBe('first entry');
    expect(await archive.readText(archive.entries[1] as never)).toBe('second entry');
  });

  it('finds the end record behind an archive comment, even one that mimics it', async () => {
    const archive = await openBuilt([{ name: 'a.dat', data: 'payload' }], {
      comment: `built by test PK\x05\x06 0000000000000000 trailing`,
    });
    expect(await archive.readText(archive.entries[0] as never)).toBe('payload');
  });

  it('handles a long archive comment', async () => {
    const archive = await openBuilt([{ name: 'a.dat', data: 'payload' }], {
      comment: 'c'.repeat(60_000),
    });
    expect(archive.entries).toHaveLength(1);
  });

  it('lists an archive with no entries', async () => {
    const archive = await openBuilt([]);
    expect(archive.entries).toEqual([]);
  });

  it('surfaces a corrupt deflate stream to the reader', async () => {
    const bytes = buildZip([{ name: 'a.dat', data: 'compressible '.repeat(2000) }]);
    // The data starts after the 30-byte local header and the 5-byte name.
    for (let i = 35; i < 60; i++) bytes[i] = 0xff;
    const archive = await openZipArchive(await writeArchive(bytes));
    open.push(archive);
    await expect(archive.readText(archive.entries[0] as never)).rejects.toThrow();
  });
});

describe('refusals at open', () => {
  it('refuses an encrypted entry', async () => {
    await expectOpenRefusal(
      buildZip([{ name: 'secret.dat', data: 'x', flags: 0x1 }]),
      /Encrypted ZIP entry "secret\.dat"/,
    );
  });

  it('refuses a ZIP64 locator', async () => {
    await expectOpenRefusal(
      buildZip([{ name: 'a.dat', data: 'x' }], { zip64Locator: true }),
      /ZIP64 archives are not supported/,
    );
  });

  it('refuses a saturated entry count', async () => {
    await expectOpenRefusal(
      buildZip([{ name: 'a.dat', data: 'x' }], { totalEntries: 0xffff }),
      /ZIP64 archives are not supported/,
    );
  });

  it('refuses ZIP64 sizes on an entry', async () => {
    await expectOpenRefusal(
      buildZip([{ name: 'big.dat', data: 'x', zip64Sizes: true }]),
      /ZIP64 entry "big\.dat"/,
    );
  });

  it('refuses a multi-disk archive', async () => {
    await expectOpenRefusal(
      buildZip([{ name: 'a.dat', data: 'x' }], { diskNumber: 1 }),
      /Multi-disk/,
    );
  });

  it('refuses bytes that are not a zip', async () => {
    await expectOpenRefusal(
      Buffer.from('<html>403 Forbidden</html>'.repeat(10)),
      /Not a ZIP archive/,
    );
  });

  it('refuses a file shorter than an end record', async () => {
    await expectOpenRefusal(Buffer.from('PK'), /Not a ZIP archive/);
    await expectOpenRefusal(Buffer.alloc(0), /Not a ZIP archive/);
  });

  it('refuses a central directory that lies past the end of the file', async () => {
    await expectOpenRefusal(
      buildZip([{ name: 'a.dat', data: 'x' }], { directoryOffset: 1_000_000 }),
      /Truncated ZIP archive/,
    );
  });

  it('refuses a directory whose entry signature is damaged', async () => {
    const bytes = buildZip([{ name: 'a.dat', data: 'x' }]);
    const directoryStart = bytes.length - 22 - (46 + 'a.dat'.length);
    bytes.writeUInt32LE(0xdeadbeef, directoryStart);
    await expectOpenRefusal(bytes, /Corrupt ZIP central directory/);
  });

  it('refuses a directory that announces more entries than it holds', async () => {
    await expectOpenRefusal(
      buildZip([{ name: 'a.dat', data: 'x' }], { totalEntries: 3 }),
      /Corrupt ZIP central directory/,
    );
  });

  it('names the file in the error', async () => {
    const path = await writeArchive(Buffer.from('not a zip at all, just text'), 'bad.zip');
    await expect(openZipArchive(path)).rejects.toThrow(/bad\.zip/);
  });

  it('rejects a path that does not exist', async () => {
    await expect(openZipArchive(join(dir, 'missing.zip'))).rejects.toMatchObject({
      code: 'ENOENT',
    });
  });
});

describe('refusals at entry open', () => {
  it('lists a method-12 entry but refuses to read it', async () => {
    const archive = await openBuilt([
      { name: 'bz.dat', data: 'x', methodCode: 12 },
      { name: 'ok.dat', data: 'fine' },
    ]);
    const bad = archive.find('bz.dat') as NonNullable<ReturnType<ZipArchive['find']>>;
    expect(bad.method).toBe(12);
    await expect(archive.openEntry(bad)).rejects.toMatchObject({
      code: JsonRpcErrorCode.SerializationError,
      message: expect.stringMatching(/compression method 12/),
    });
    await expect(archive.readText(bad)).rejects.toThrow(/compression method 12/);
    expect(await archive.readText(archive.find('ok.dat') as never)).toBe('fine');
  });

  it('refuses an entry whose local header is corrupt', async () => {
    const bytes = buildZip([
      { name: 'a.dat', data: 'first' },
      { name: 'b.dat', data: 'second' },
    ]);
    bytes.writeUInt32LE(0, 0);
    const archive = await openZipArchive(await writeArchive(bytes));
    open.push(archive);
    await expect(archive.openEntry(archive.entries[0] as never)).rejects.toMatchObject({
      code: JsonRpcErrorCode.SerializationError,
      message: expect.stringMatching(/Corrupt local header for ZIP entry "a\.dat"/),
    });
    expect(await archive.readText(archive.entries[1] as never)).toBe('second');
  });

  it('refuses an entry whose local header offset points past the file', async () => {
    const bytes = buildZip([{ name: 'a.dat', data: 'first' }]);
    const central = bytes.length - 22 - (46 + 'a.dat'.length);
    bytes.writeUInt32LE(bytes.length + 500, central + 42);
    const archive = await openZipArchive(await writeArchive(bytes));
    open.push(archive);
    await expect(archive.openEntry(archive.entries[0] as never)).rejects.toMatchObject({
      code: JsonRpcErrorCode.SerializationError,
    });
  });
});
