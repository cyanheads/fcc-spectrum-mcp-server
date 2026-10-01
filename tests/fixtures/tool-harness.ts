/**
 * @fileoverview Shared helpers for the tool and resource tests: point the service accessor
 * at a mirror directory, read the two surfaces of a `runToolContract` result, assert that a
 * declared error contract reached both, check that rendered markdown carries every value of
 * a structured result, and forge pagination cursors.
 * @module tests/fixtures/tool-harness
 */

import type { runToolContract } from '@cyanheads/mcp-ts-core/testing';
import { expect } from 'vitest';
import type { ServiceGroup } from '@/services/uls/codes.js';
import { initUlsIndexService, type UlsIndexService } from '@/services/uls/uls-index-service.js';
import { FIXTURE_GROUPS } from './uls-index.js';

/** What `runToolContract` resolves to. */
export type ContractResult = Awaited<ReturnType<typeof runToolContract>>;

/** The `structuredContent.error` of a failed contract run. */
export interface ContractError {
  code: number;
  data?: Record<string, unknown> & { reason?: string; recovery?: { hint?: string } };
  message: string;
}

/** Enrichment every search-shaped tool declares. */
export interface PageEnrichment {
  appliedFilters: Record<string, unknown>;
  cap: number;
  dataAsOf: string;
  notice?: string;
  shown: number;
  totalCount: number;
  truncated: boolean;
}

/** One declared error-contract entry, as a tool or resource definition carries it. */
interface DeclaredError {
  code: number;
  reason: string;
  recovery: string;
}

/** Stamp of the fixture generation, bound into every cursor it mints. */
export const FIXTURE_GENERATION_ID = '20260927T133855Z';

let current: UlsIndexService | undefined;

/**
 * Point the tools' service accessor at `mirrorDir` (pointer re-read on every call), closing
 * the service the previous call created.
 */
export async function useIndex(
  mirrorDir: string,
  options: { redactIndividuals?: boolean; services?: readonly ServiceGroup[] } = {},
): Promise<UlsIndexService> {
  await current?.close();
  current = initUlsIndexService({
    mirrorDir,
    pointerCheckMs: 0,
    redactIndividuals: options.redactIndividuals ?? true,
    services: options.services ?? FIXTURE_GROUPS,
  });
  return current;
}

/** Close the service the last {@link useIndex} created. */
export async function releaseIndex(): Promise<void> {
  await current?.close();
  current = undefined;
}

/** Every text block of a result, joined. */
export function contractText(result: { content?: readonly unknown[] }): string {
  return ((result.content ?? []) as { text?: string }[])
    .map((block) => block.text ?? '')
    .join('\n');
}

/** The `structuredContent` of a successful run. */
export function successOf<T>(result: ContractResult): T {
  expect(result.isError ?? false, contractText(result)).toBe(false);
  return result.structuredContent as T;
}

/** The `structuredContent.error` of a failed run. */
export function errorOf(result: ContractResult): ContractError {
  expect(result.isError).toBe(true);
  return (result.structuredContent as { error: ContractError }).error;
}

/**
 * Assert that a failure carries the declared contract entry for `reason` on both surfaces:
 * its code and reason in `structuredContent.error`, its recovery as the hint, and the
 * message, recovery, and reason in `content[]`.
 */
export function expectDeclaredError(
  definition: { errors?: readonly DeclaredError[] },
  result: ContractResult,
  reason: string,
): ContractError {
  const entry = definition.errors?.find((candidate) => candidate.reason === reason);
  expect(entry, `"${reason}" is a declared reason`).toBeDefined();
  const error = errorOf(result);
  expect(error.code).toBe(entry?.code);
  expect(error.data?.reason).toBe(reason);
  expect(error.data?.recovery?.hint).toBe(entry?.recovery);
  const rendered = contractText(result);
  expect(rendered).toContain(`Error: ${error.message}`);
  expect(rendered).toContain(`Recovery: ${entry?.recovery}`);
  expect(rendered).toContain(`reason ${reason}`);
  return error;
}

/** Registry text as an inline markdown slot shows it: CR/LF runs flattened to one space. */
const flattened = (text: string) => text.replace(/[\r\n]+/g, ' ');

/**
 * Assert that `rendered` carries every string and number in `value`, recursively. Strings
 * are compared as an inline slot renders them. Booleans and nulls are asserted by callers,
 * since each tool words them its own way.
 */
export function expectCarries(rendered: string, value: unknown, path = '$'): void {
  if (typeof value === 'string') {
    expect(rendered, path).toContain(flattened(value));
  } else if (typeof value === 'number') {
    expect(rendered, path).toContain(String(value));
  } else if (Array.isArray(value)) {
    value.forEach((item, i) => {
      expectCarries(rendered, item, `${path}[${i}]`);
    });
  } else if (value !== null && typeof value === 'object') {
    for (const [key, item] of Object.entries(value))
      expectCarries(rendered, item, `${path}.${key}`);
  }
}

/** The single text block a `format()` call renders. */
export function formattedText(blocks: readonly unknown[] | undefined): string {
  expect(blocks).toHaveLength(1);
  const [block] = blocks ?? [];
  return (block as { text: string }).text;
}

/** A cursor shaped like the index service's, for a generation and tag of the test's choosing. */
export const forgeCursor = (...parts: unknown[]) =>
  Buffer.from(JSON.stringify(parts)).toString('base64url');

/** Decimal degrees of a DMS fixture coordinate. */
export const dms = (deg: number, min: number, sec: number, negative = false) =>
  (negative ? -1 : 1) * (deg + min / 60 + sec / 3600);
