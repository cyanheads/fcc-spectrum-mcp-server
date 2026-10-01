/**
 * @fileoverview The organization-word list that decides whether a licensee name filed with
 * no applicant type, or with type `H` (Other), names an organization. Such a name with none
 * of these words is classified as an individual, so its name and city are redacted.
 * @module services/uls/organization-names
 */

/**
 * Words that mark a licensee name as an organization's: business forms, public bodies and
 * government, tribal nations, safety services, institutions, community and education groups,
 * and trades. Matched as whole words, so `TOWNSEND` and `CHURCHILL` are not matches. Words common
 * in personal names (`CHRISTIAN`, `CABLE`), filed beside a person's name (`MANAGEMENT`, as in
 * "<name>, Management Trustee"), or ambiguous in ULS names (`AMERICAN`, `INTERNATIONAL`) stay
 * out.
 */
export const ORGANIZATION_WORDS: ReadonlySet<string> = new Set([
  // Business forms
  'INC',
  'LLC',
  'CORP',
  'CORPORATION',
  'CO',
  'COMPANY',
  'LTD',
  'LP',
  'LLP',
  'PC',
  'PA',
  'PLLC',
  'DBA',
  // Public bodies and government
  'CITY',
  'COUNTY',
  'STATE',
  'TOWN',
  'TOWNSHIP',
  'VILLAGE',
  'BOROUGH',
  'PARISH',
  'DISTRICT',
  'AUTHORITY',
  'BOARD',
  'COMMISSION',
  'DEPARTMENT',
  'DEPT',
  'AGENCY',
  'BUREAU',
  'OFFICE',
  'GOVERNMENT',
  'PUBLIC',
  'REGIONAL',
  'NATIONAL',
  // Tribal nations
  'TRIBE',
  'TRIBES',
  'TRIBAL',
  'NATION',
  'NATIONS',
  'INDIAN',
  'INDIANS',
  'PUEBLO',
  'RESERVATION',
  'RANCHERIA',
  'NATIVE',
  // Safety services
  'POLICE',
  'SHERIFF',
  'FIRE',
  'RESCUE',
  'AMBULANCE',
  'EMS',
  // Institutions
  'SCHOOL',
  'SCHOOLS',
  'COLLEGE',
  'UNIVERSITY',
  'ACADEMY',
  'HOSPITAL',
  'MEDICAL',
  'CLINIC',
  'CHURCH',
  'MINISTRIES',
  'MINISTRY',
  'TEMPLE',
  'FOUNDATION',
  'ASSOCIATION',
  'ASSN',
  'SOCIETY',
  'CLUB',
  'COUNCIL',
  'LEAGUE',
  'UNION',
  'COOPERATIVE',
  'COOP',
  'TRUST',
  'PARTNERS',
  'PARTNERSHIP',
  'GROUP',
  'HOLDINGS',
  'ENTERPRISES',
  'INDUSTRIES',
  // Community and education groups
  'COMMUNITY',
  'EDUCATION',
  'EDUCATIONAL',
  'INSTITUTE',
  'CENTER',
  'FUND',
  'DIOCESE',
  'BAPTIST',
  'METHODIST',
  // Trades
  'SERVICES',
  'SERVICE',
  'SYSTEMS',
  'COMMUNICATIONS',
  'ELECTRIC',
  'TELEPHONE',
  'WIRELESS',
  'RADIO',
  'BROADCASTING',
  'NETWORK',
  'TRANSPORTATION',
  'CONSTRUCTION',
  'FARMS',
  'FARM',
  'RANCH',
  'AIRPORT',
  'UTILITIES',
  'WATER',
  'POWER',
  'ENERGY',
  'BROADBAND',
  'TELEVISION',
  'TELECOM',
  'TECHNOLOGY',
  'TECHNOLOGIES',
  'SOLUTIONS',
  'CONSULTING',
  'TRUCKING',
  'PRODUCTIONS',
  'MEDIA',
  'ALLIANCE',
  'ENGINEERING',
]);

/**
 * Two or more single letters, each followed directly by a dot: `L.L.C.`, `L.P.`. Spaced
 * initials (`P. A. Smith`) don't qualify, so a person's initials never spell a business form.
 */
const DOTTED_LETTERS = /(?<![\p{L}\p{N}])(?:\p{L}\.){2,}/gu;

/**
 * True when `name` holds one of the {@link ORGANIZATION_WORDS} as a whole word, in any case.
 * Words are the runs of letters and digits between any other characters, so `Inc.` and
 * `SMITH-JONES LLP` match. A run of two or more single letters each followed directly by a
 * dot first collapses into one word, so `L.L.C.` matches `LLC` and `L.P.` matches `LP`; a lone
 * initial (`W. Stephen`) and spaced initials (`P. A. Smith`) stay words of their own.
 */
export function hasOrganizationWord(name: string | null): boolean {
  if (!name) return false;
  return name
    .toUpperCase()
    .replace(DOTTED_LETTERS, (run) => `${run.replace(/\./g, '')} `)
    .split(/[^\p{L}\p{N}]+/u)
    .some((word) => ORGANIZATION_WORDS.has(word));
}
