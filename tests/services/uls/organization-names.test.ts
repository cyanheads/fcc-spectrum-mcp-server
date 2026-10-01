/**
 * @fileoverview Tests for the organization-word match that decides whether a licensee name
 * with no applicant type, or type `H`, names an organization: whole words only, any case,
 * any punctuation around them.
 * @module tests/services/uls/organization-names.test
 */

import { describe, expect, it } from 'vitest';
import { hasOrganizationWord, ORGANIZATION_WORDS } from '@/services/uls/organization-names.js';

describe('hasOrganizationWord', () => {
  it.each([
    'NORTHWEST PAGING INC',
    'Northwest Paging, Inc.',
    'TOWN OF EXAMPLE',
    'Example County Sheriff',
    'ACME CO.',
    'Smith & Jones LLC',
    'ST. MARY HOSPITAL',
    'FIRST BAPTIST CHURCH',
    'VALLEY ELECTRIC COOP',
    'RIVERSIDE FARMS',
    'smith-jones llp',
  ])('finds an organization word in %j', (name) => {
    expect(hasOrganizationWord(name)).toBe(true);
  });

  it.each([
    'ROGER Q. EXAMPLE',
    'SMITH TOWNSEND',
    'CHURCHILL, ALEX',
    'INCE, PAT',
    'COLEMAN J. DOE',
    'FARMER, JO',
    'AÑASCO SANTOS',
    '',
  ])('finds none in %j', (name) => {
    expect(hasOrganizationWord(name)).toBe(false);
  });

  it('finds none in a missing name', () => {
    expect(hasOrganizationWord(null)).toBe(false);
  });

  it.each(['EXAMPLE CREEK NATION', 'SAMPLE RIVER TRIBE', 'PUEBLO OF EXAMPLE'])(
    'reads the tribal name %j as an organization',
    (name) => {
      expect(hasOrganizationWord(name)).toBe(true);
    },
  );

  it.each([
    'EXAMPLE COMMUNITY CENTER',
    'SAMPLE REGIONAL GOVERNMENT',
    'EXAMPLE TRUCKING',
    'Sample Media',
  ])('finds a community, government, or trade word in %j', (name) => {
    expect(hasOrganizationWord(name)).toBe(true);
  });

  it.each(['SAMPLE TOWER, L.L.C.', 'WXYZ Licensee L.P.', 'sample tower l.l.c.'])(
    'collapses the dotted business form in %j into one word',
    (name) => {
      expect(hasOrganizationWord(name)).toBe(true);
    },
  );

  it.each(['W. STEPHEN SMITH', 'J.R. SAMPLE', 'P. A. SMITH', 'C. O. JONES'])(
    'keeps the initials in %j from spelling an organization word',
    (name) => {
      expect(hasOrganizationWord(name)).toBe(false);
    },
  );

  it.each(['SMITH, MANAGEMENT TRUSTEE', 'JOHN CHRISTIAN'])(
    'finds none in %j, whose words are also personal',
    (name) => {
      expect(hasOrganizationWord(name)).toBe(false);
    },
  );

  it('holds every word upper case, so the match runs on an upper-cased name', () => {
    for (const word of ORGANIZATION_WORDS) expect(word).toBe(word.toUpperCase());
    expect(ORGANIZATION_WORDS.has('LLC')).toBe(true);
    expect(ORGANIZATION_WORDS.has('TOWNSEND')).toBe(false);
  });
});
