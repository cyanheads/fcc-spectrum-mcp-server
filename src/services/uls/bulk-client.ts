/**
 * @fileoverview HTTP client for the FCC ULS bulk host (`data.fcc.gov/download/pub/uls/`):
 * the daily directory listing, HEAD for `Last-Modified`, and streamed zip downloads to
 * disk. Every request runs behind a one-per-second pacer inside a `withRetry` boundary
 * with a per-file deadline. Redirects are read, not followed: the host answers a missing
 * path with `302` to a page that returns `403`.
 * @module services/uls/bulk-client
 */

import { createWriteStream } from 'node:fs';
import { rename, rm } from 'node:fs/promises';
import { Readable, Transform, type TransformCallback } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { config } from '@cyanheads/mcp-ts-core/config';
import { notFound, serviceUnavailable } from '@cyanheads/mcp-ts-core/errors';
import {
  createPacer,
  httpErrorFromResponse,
  type Pacer,
  withRetry,
} from '@cyanheads/mcp-ts-core/utils';
import type { ServiceGroup } from './codes.js';
import { toIsoSeconds } from './dat.js';

/** Total budget for one weekly snapshot download, retries included. */
export const WEEKLY_DOWNLOAD_DEADLINE_MS = 20 * 60_000;

/** Total budget for one daily zip download, a HEAD, or the listing, retries included. */
export const DAILY_REQUEST_DEADLINE_MS = 60_000;

const RETRY_BASE_DELAY_MS = 2000;
const MAX_RETRIES = 3;
const ZIP_MAGIC = Buffer.from([0x50, 0x4b, 0x03, 0x04]);

/** Path of a weekly license snapshot, relative to the bulk root. */
export function weeklyZipPath(group: ServiceGroup): string {
  return `complete/l_${group}.zip`;
}

/** Path of a daily license incremental (`l_am_mon.zip`), relative to the bulk root. */
export function dailyZipPath(fileName: string): string {
  return `daily/${fileName}`;
}

/** Constructor options. `fetch` and `now` are the test seams. */
export interface UlsBulkClientOptions {
  /** Bulk host root, no trailing slash (`https://data.fcc.gov/download/pub/uls`). */
  baseUrl: string;
  fetch?: typeof globalThis.fetch;
  now?: () => number;
  /** Server version for the User-Agent; defaults to the application's package version. */
  version?: string;
}

/** A remote file's metadata from HEAD. */
export interface UlsRemoteFile {
  /** `Last-Modified` as fixed-width UTC ISO 8601. */
  lastModified: string;
  path: string;
  /** `Content-Length`, when the host sent one. */
  sizeBytes?: number;
}

/** A completed download. */
export interface UlsDownload extends UlsRemoteFile {
  /** Where the zip was written. */
  destination: string;
  /** When the download finished, as fixed-width UTC ISO 8601. */
  fetchedAt: string;
  /** Bytes written. */
  sizeBytes: number;
}

/** Client for the ULS bulk host. Dispose it to release the pacer's queue and timer. */
export class UlsBulkClient {
  private readonly baseUrl: string;
  private readonly fetchFn: typeof globalThis.fetch;
  private readonly now: () => number;
  private readonly userAgent: string;
  private readonly pacer: Pacer;

  constructor(options: UlsBulkClientOptions) {
    this.baseUrl = options.baseUrl.replace(/\/+$/, '');
    this.fetchFn = options.fetch ?? globalThis.fetch;
    this.now = options.now ?? Date.now;
    this.userAgent = `fcc-spectrum-mcp-server/${options.version ?? config.mcpServerVersion}`;
    this.pacer = createPacer({
      name: 'fcc-uls-bulk',
      minStartGapMs: 1000,
      cooldown: { baseMs: 5000, maxMs: 120_000 },
    });
  }

  /** Names of the daily license incrementals (`l_*.zip`) the `daily/` listing links. */
  listDailyFiles(signal?: AbortSignal): Promise<string[]> {
    const path = 'daily/';
    return this.withRetry('listDailyFiles', DAILY_REQUEST_DEADLINE_MS, signal, async (attempt) => {
      const response = await this.request(path, 'GET', attempt);
      if (response === 'missing')
        throw notFound(`The ULS bulk host has no ${path} listing.`, { path });
      const html = await response.text();
      const names = new Set<string>();
      for (const match of html.matchAll(/href="(l_[a-z0-9]+_[a-z]+\.zip)"/gi)) {
        if (match[1]) names.add(match[1]);
      }
      return [...names].sort();
    });
  }

  /** HEAD a file; `null` when the host reports it missing. */
  head(path: string, signal?: AbortSignal): Promise<UlsRemoteFile | null> {
    return this.withRetry(`head ${path}`, DAILY_REQUEST_DEADLINE_MS, signal, async (attempt) => {
      const response = await this.request(path, 'HEAD', attempt);
      if (response === 'missing') return null;
      return this.remoteFile(path, response);
    });
  }

  /**
   * Stream a zip to `destination`, writing through `<destination>.part` and renaming on
   * success so a partial file is never left under the final name. A body that is not a
   * zip (an HTML error page served as 200) or is shorter than its `Content-Length` is a
   * transient `ServiceUnavailable`, retried like a 5xx. A missing file is `NotFound`.
   */
  download(path: string, destination: string, signal?: AbortSignal): Promise<UlsDownload> {
    const deadlineMs = path.startsWith('complete/')
      ? WEEKLY_DOWNLOAD_DEADLINE_MS
      : DAILY_REQUEST_DEADLINE_MS;
    return this.withRetry(`download ${path}`, deadlineMs, signal, async (attempt) => {
      const response = await this.request(path, 'GET', attempt);
      if (response === 'missing') {
        throw notFound(`The ULS bulk host has no file at ${path}.`, { path });
      }
      const remote = this.remoteFile(path, response);
      if (!response.body) throw serviceUnavailable(`Empty response body for ${path}.`, { path });
      const partial = `${destination}.part`;
      const guard = new ZipBodyGuard(path);
      try {
        await pipeline(Readable.fromWeb(response.body), guard, createWriteStream(partial), {
          signal: attempt.signal,
        });
      } catch (err) {
        await rm(partial, { force: true });
        throw err;
      }
      if (remote.sizeBytes !== undefined && guard.bytes !== remote.sizeBytes) {
        await rm(partial, { force: true });
        throw serviceUnavailable(
          `Download of ${path} ended at ${guard.bytes} of ${remote.sizeBytes} bytes.`,
          { path, expectedBytes: remote.sizeBytes, receivedBytes: guard.bytes },
        );
      }
      await rename(partial, destination);
      return {
        ...remote,
        destination,
        sizeBytes: guard.bytes,
        fetchedAt: toIsoSeconds(this.now()),
      };
    });
  }

  /** Release the pacer's dispatch timer and reject any queued requests. */
  dispose(): void {
    this.pacer.dispose();
  }

  private withRetry<T>(
    operation: string,
    deadlineMs: number,
    signal: AbortSignal | undefined,
    fn: (attempt: { signal: AbortSignal }) => Promise<T>,
  ): Promise<T> {
    return withRetry(fn, {
      operation: `UlsBulkClient.${operation}`,
      baseDelayMs: RETRY_BASE_DELAY_MS,
      maxRetries: MAX_RETRIES,
      deadlineMs,
      ...(signal && { signal }),
    });
  }

  /**
   * One paced request. `2xx` returns the response; any `3xx` is the host's "file missing"
   * answer; everything else becomes a classified error (`5xx`/`408`/`429` transient).
   * Classification runs inside the paced task so a `429` closes the pacer's cooldown gate.
   */
  private request(
    path: string,
    method: 'GET' | 'HEAD',
    attempt: { signal: AbortSignal },
  ): Promise<Response | 'missing'> {
    const url = `${this.baseUrl}/${path}`;
    return this.pacer.run(
      async (signal) => {
        const response = await this.fetchFn(url, {
          method,
          redirect: 'manual',
          headers: { 'User-Agent': this.userAgent },
          signal,
        });
        if (response.status >= 200 && response.status < 300) return response;
        if (response.status >= 300 && response.status < 400) {
          await response.body?.cancel();
          return 'missing' as const;
        }
        throw await httpErrorFromResponse(response, {
          service: 'FCC ULS bulk host',
          data: { path },
        });
      },
      { signal: attempt.signal },
    );
  }

  private remoteFile(path: string, response: Response): UlsRemoteFile {
    const lastModified = Date.parse(response.headers.get('last-modified') ?? '');
    if (Number.isNaN(lastModified)) {
      throw serviceUnavailable(`The ULS bulk host sent no Last-Modified for ${path}.`, { path });
    }
    const length = Number(response.headers.get('content-length') ?? Number.NaN);
    return {
      path,
      lastModified: toIsoSeconds(lastModified),
      ...(Number.isSafeInteger(length) && length >= 0 && { sizeBytes: length }),
    };
  }
}

/**
 * Pass-through that counts bytes and fails the stream when the first four bytes are not
 * a ZIP local-file header — the host's error pages arrive as `200 text/html`.
 */
class ZipBodyGuard extends Transform {
  bytes = 0;
  private head = Buffer.alloc(0);

  constructor(private readonly path: string) {
    super();
  }

  override _transform(chunk: Buffer, _encoding: BufferEncoding, callback: TransformCallback): void {
    if (this.head.length < ZIP_MAGIC.length) {
      this.head = Buffer.concat([this.head, chunk]).subarray(0, ZIP_MAGIC.length);
      if (!ZIP_MAGIC.subarray(0, this.head.length).equals(this.head)) {
        callback(this.notZip());
        return;
      }
    }
    this.bytes += chunk.length;
    callback(null, chunk);
  }

  override _flush(callback: TransformCallback): void {
    callback(this.head.length < ZIP_MAGIC.length ? this.notZip() : null);
  }

  private notZip(): Error {
    return serviceUnavailable(`The ULS bulk host returned a non-zip body for ${this.path}.`, {
      path: this.path,
    });
  }
}
