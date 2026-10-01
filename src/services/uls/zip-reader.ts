/**
 * @fileoverview Minimal streaming ZIP reader for the ULS bulk archives. Reads the end of
 * central directory and the central directory, then streams one entry's compressed byte
 * range through `zlib.createInflateRaw()` — never buffering an entry whole. Stored and
 * DEFLATE entries only; ZIP64, multi-disk, and encrypted archives are refused.
 * @module services/uls/zip-reader
 */

import { createReadStream } from 'node:fs';
import { type FileHandle, open } from 'node:fs/promises';
import { pipeline, Readable } from 'node:stream';
import { createInflateRaw } from 'node:zlib';
import { serializationError } from '@cyanheads/mcp-ts-core/errors';
import { readLines } from './dat.js';

const EOCD_SIGNATURE = 0x06054b50;
const ZIP64_LOCATOR_SIGNATURE = 0x07064b50;
const CENTRAL_SIGNATURE = 0x02014b50;
const LOCAL_SIGNATURE = 0x04034b50;
const EOCD_SIZE = 22;
const CENTRAL_HEADER_SIZE = 46;
const LOCAL_HEADER_SIZE = 30;
const MAX_COMMENT = 0xffff;
const U16_MAX = 0xffff;
const U32_MAX = 0xffffffff;

const METHOD_STORED = 0;
const METHOD_DEFLATE = 8;

/**
 * Most bytes {@link ZipArchive.readText} reads before refusing the entry. The one text
 * entry it serves, a weekly `counts` file, is under 2 KB.
 */
export const MAX_TEXT_ENTRY_BYTES = 65_536;

/** One file inside the archive, as the central directory describes it. */
export interface ZipEntry {
  compressedSize: number;
  localHeaderOffset: number;
  /** Compression method: 0 stored, 8 DEFLATE; anything else fails on open. */
  method: number;
  /** Entry name as stored (ULS mixes cases: `HD.dat`, `ll.dat`). */
  name: string;
  uncompressedSize: number;
}

/** An open archive. Call {@link ZipArchive.close} when done. */
export interface ZipArchive {
  close(): Promise<void>;
  readonly entries: readonly ZipEntry[];
  /** Stream an entry as UTF-8 lines (see `readLines` in `dat.ts`). */
  entryLines(entry: ZipEntry): AsyncGenerator<string>;
  /** Find an entry by name, case-insensitively. */
  find(name: string): ZipEntry | undefined;
  /** Stream an entry's uncompressed bytes. */
  openEntry(entry: ZipEntry): Promise<Readable>;
  readonly path: string;
  /**
   * Read a small entry (such as `counts`) whole as UTF-8 text; an entry longer than
   * {@link MAX_TEXT_ENTRY_BYTES} fails with `SerializationError`.
   */
  readText(entry: ZipEntry): Promise<string>;
}

/** Open a ZIP archive on disk and read its central directory. */
export async function openZipArchive(path: string): Promise<ZipArchive> {
  const handle = await open(path, 'r');
  try {
    const entries = await readCentralDirectory(handle, path);
    return createArchive(path, handle, entries);
  } catch (err) {
    await handle.close();
    throw err;
  }
}

async function readBytes(handle: FileHandle, position: number, length: number): Promise<Buffer> {
  const buffer = Buffer.alloc(length);
  const { bytesRead } = await handle.read(buffer, 0, length, position);
  return buffer.subarray(0, bytesRead);
}

function zipError(path: string, message: string): Error {
  return serializationError(`${message} (${path})`, { path });
}

async function readCentralDirectory(handle: FileHandle, path: string): Promise<ZipEntry[]> {
  const { size } = await handle.stat();
  const tailLength = Math.min(size, EOCD_SIZE + MAX_COMMENT);
  const tail = await readBytes(handle, size - tailLength, tailLength);

  let eocd = -1;
  for (let i = tail.length - EOCD_SIZE; i >= 0; i--) {
    if (
      tail.readUInt32LE(i) === EOCD_SIGNATURE &&
      i + EOCD_SIZE + tail.readUInt16LE(i + 20) === tail.length
    ) {
      eocd = i;
      break;
    }
  }
  if (eocd === -1) throw zipError(path, 'Not a ZIP archive: no end of central directory record');
  if (eocd >= 20 && tail.readUInt32LE(eocd - 20) === ZIP64_LOCATOR_SIGNATURE) {
    throw zipError(path, 'ZIP64 archives are not supported');
  }

  const diskNumber = tail.readUInt16LE(eocd + 4);
  const totalEntries = tail.readUInt16LE(eocd + 10);
  const directorySize = tail.readUInt32LE(eocd + 12);
  const directoryOffset = tail.readUInt32LE(eocd + 16);
  if (diskNumber !== 0) throw zipError(path, 'Multi-disk ZIP archives are not supported');
  if (totalEntries === U16_MAX || directorySize === U32_MAX || directoryOffset === U32_MAX) {
    throw zipError(path, 'ZIP64 archives are not supported');
  }
  if (directoryOffset + directorySize > size) {
    throw zipError(path, 'Truncated ZIP archive: central directory lies past the end of the file');
  }

  const directory = await readBytes(handle, directoryOffset, directorySize);
  const entries: ZipEntry[] = [];
  let offset = 0;
  for (let i = 0; i < totalEntries; i++) {
    if (
      offset + CENTRAL_HEADER_SIZE > directory.length ||
      directory.readUInt32LE(offset) !== CENTRAL_SIGNATURE
    ) {
      throw zipError(path, 'Corrupt ZIP central directory');
    }
    const flags = directory.readUInt16LE(offset + 8);
    const method = directory.readUInt16LE(offset + 10);
    const compressedSize = directory.readUInt32LE(offset + 20);
    const uncompressedSize = directory.readUInt32LE(offset + 24);
    const nameLength = directory.readUInt16LE(offset + 28);
    const extraLength = directory.readUInt16LE(offset + 30);
    const commentLength = directory.readUInt16LE(offset + 32);
    const localHeaderOffset = directory.readUInt32LE(offset + 42);
    const nameBytes = directory.subarray(
      offset + CENTRAL_HEADER_SIZE,
      offset + CENTRAL_HEADER_SIZE + nameLength,
    );
    const name = nameBytes.toString(flags & 0x800 ? 'utf8' : 'latin1');
    if (flags & 0x1) throw zipError(path, `Encrypted ZIP entry "${name}" is not supported`);
    if (
      compressedSize === U32_MAX ||
      uncompressedSize === U32_MAX ||
      localHeaderOffset === U32_MAX
    ) {
      throw zipError(path, `ZIP64 entry "${name}" is not supported`);
    }
    entries.push({ name, method, compressedSize, uncompressedSize, localHeaderOffset });
    offset += CENTRAL_HEADER_SIZE + nameLength + extraLength + commentLength;
  }
  return entries;
}

function createArchive(path: string, handle: FileHandle, entries: ZipEntry[]): ZipArchive {
  const byName = new Map(entries.map((entry) => [entry.name.toLowerCase(), entry]));

  async function openEntry(entry: ZipEntry): Promise<Readable> {
    if (entry.method !== METHOD_STORED && entry.method !== METHOD_DEFLATE) {
      throw zipError(
        path,
        `ZIP entry "${entry.name}" uses compression method ${entry.method}; only stored and DEFLATE are supported`,
      );
    }
    const header = await readBytes(handle, entry.localHeaderOffset, LOCAL_HEADER_SIZE);
    if (header.length < LOCAL_HEADER_SIZE || header.readUInt32LE(0) !== LOCAL_SIGNATURE) {
      throw zipError(path, `Corrupt local header for ZIP entry "${entry.name}"`);
    }
    if (entry.compressedSize === 0) return Readable.from([]);
    const start =
      entry.localHeaderOffset +
      LOCAL_HEADER_SIZE +
      header.readUInt16LE(26) +
      header.readUInt16LE(28);
    const raw = createReadStream(path, { start, end: start + entry.compressedSize - 1 });
    if (entry.method === METHOD_STORED) return raw;
    // Errors on either stream destroy the other; the consumer sees them through the inflater.
    return pipeline(raw, createInflateRaw(), () => {});
  }

  return {
    path,
    entries,
    find: (name) => byName.get(name.toLowerCase()),
    openEntry,
    async *entryLines(entry) {
      yield* readLines(await openEntry(entry));
    },
    async readText(entry) {
      const chunks: Buffer[] = [];
      let bytes = 0;
      for await (const chunk of await openEntry(entry)) {
        bytes += (chunk as Buffer).length;
        // Leaving the loop destroys the entry stream.
        if (bytes > MAX_TEXT_ENTRY_BYTES) {
          throw zipError(
            path,
            `ZIP entry "${entry.name}" holds more than ${MAX_TEXT_ENTRY_BYTES} bytes of text`,
          );
        }
        chunks.push(chunk as Buffer);
      }
      return Buffer.concat(chunks).toString('utf8');
    },
    close: () => handle.close(),
  };
}
