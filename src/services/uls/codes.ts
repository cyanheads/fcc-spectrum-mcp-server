/**
 * @fileoverview Bundled ULS code tables and the weekly service-group vocabulary.
 * Radio service labels are transcribed from the FCC's `uls_radio_service_codes.csv`
 * (the `AL,ALL` wildcard row dropped); license statuses, location types, antenna
 * types, applicant types, and amateur operator classes from the FCC's
 * `uls_code_definitions_20240718.txt`. A code observed in the index but absent here
 * is still valid — callers fall back to the code as its label.
 * @module services/uls/codes
 */

/** One decoded code: the value as filed and its FCC label. */
export interface CodeEntry {
  code: string;
  label: string;
}

/** Radio service code → label (HD field 7). */
export const RADIO_SERVICES: Readonly<Record<string, string>> = {
  AA: 'Aviation Auxiliary Group',
  AB: 'Aural Microwave Booster',
  AC: 'Aircraft',
  AD: 'AWS-4 (2000-2020 MHz and 2180-2200 MHz)',
  AF: 'Aeronautical and Fixed',
  AH: 'AWS-H Block (at 1915-1920 MHz and 1995-2000 MHz)',
  AI: 'Aural Intercity Relay',
  AN: 'Antenna Structure Registration',
  AR: 'Aviation Radionavigation',
  AS: 'Aural Studio Transmitter Link',
  AT: 'AWS-3 (1695-1710 MHz, 1755-1780 MHz, and 2155-2180 MHz)',
  AW: 'AWS (1710-1755 MHz and 2110-2155 MHz)',
  BA: '1390-1392 MHz Band, Market Area',
  BB: '1392-1395 and 1432-1435 MHz Bands, Market Area',
  BC: '1670-1675 MHz Band, Market Area',
  BR: 'Broadband Radio Service',
  BS: '900 MHz Broadband Service',
  CA: 'Commercial Air-ground Radiotelephone',
  CB: 'BETRS',
  CD: 'Paging and Radiotelephone',
  CE: 'Digital Electronic Message Service - Common Carrier',
  CF: 'Common Carrier Fixed Point to Point Microwave',
  CG: 'General Aviation Air-ground Radiotelephone',
  CJ: 'Commercial Aviation Air-Ground Radiotelephone (800 MHz band)',
  CL: 'Cellular',
  CM: 'Commercial Operator',
  CN: 'PCS Narrowband',
  CO: 'Offshore Radiotelephone',
  CP: 'Part 22 VHF/UHF Paging (excluding 931MHz)',
  CR: 'Rural Radiotelephone',
  CT: 'Local Television Transmission',
  CW: 'PCS Broadband',
  CX: 'Cellular, Auctioned',
  CY: '1910-1915/1990-1995 MHz Bands, Market Area',
  CZ: 'Part 22 931 MHZ Paging',
  DV: 'Multichannel Video Distribution AND Data Service',
  ED: 'Educational Broadband Service',
  GB: 'Business, 806-821/851-866 MHz, Conventional',
  GC: '929-931 MHz Band, Auctioned',
  GE: 'PubSafty/SpecEmer/PubSaftyNtlPlan,806-817/851-862MHz,Conv',
  GF: 'Public Safety Ntl Plan, 821-824/866-869 MHz, Conv.',
  GI: 'Other Indust/Land Transp, 896-901/935-940 MHz, Conv.',
  GJ: 'Business/Industrial/Land Trans, 809-824/854-869 MHz, Conv.',
  GL: '900 MHz Conventional SMR (SMR, Site-Specific)',
  GM: '800 MHz Conventional SMR (SMR, Site-specific)',
  GO: 'Other Indust/Land Transp, 806-821/851-866 MHz, Conv.',
  GP: 'Public Safety/Spec Emerg, 806-821/851-866 MHz, Conv.',
  GR: 'SMR, 896-901/935-940 MHz, Conventional',
  GS: 'Private Carrier Paging, 929-930 MHz',
  GU: 'Business, 896-901/935-940 MHz, Conventional',
  GW: 'General Wireless Communications Service',
  GX: 'SMR, 806-821/851-866 MHz, Conventional',
  HA: 'Amateur',
  HV: 'Vanity',
  IG: 'Industrial/Business Pool, Conventional',
  IK: 'Industrial/Business Pool - Commercial, Conventional',
  IQ: 'Intelligent Transportation Service (Public Safety)',
  LD: 'Local Multipoint Distribution Service',
  LN: '902-928 MHz Location Narrowband (Non-multilateration)',
  LP: 'Broadcast Auxiliary Low Power',
  LS: 'Location and Monitoring Service, Multilateration (LMS)',
  LV: 'Low Power Wireless Assist Video Devices',
  LW: '902-928 MHz Location Wideband (Grandfathered AVM)',
  MA: 'Marine Auxiliary Group',
  MC: 'Coastal Group',
  MD: 'Multipoint Distribution Service (MDS and MMDS)',
  MG: 'Microwave Industrial/Business Pool',
  MK: 'Alaska Group',
  MM: 'Millimeter Wave 70/80/90 GHz Service',
  MR: 'Marine Radiolocation Land',
  MS: 'Multiple Address Service, Auctioned',
  MW: 'Microwave Public Safety Pool',
  NC: 'Nationwide Commercial 5 Channel, 220 MHz',
  NN: '3650-3700 MHz',
  OW: 'FCC Ownership Disclosure Information',
  PA: 'Public Safety 4940-4990 MHz Band',
  PB: '4940-4990 MHz Public Safety, Base/Mobile',
  PC: 'Public Coast Stations, Auctioned',
  PE: 'Digital Electronic Message Service - Private',
  PF: '4940-4990 MHz Public Safety, Pt-to-Pt, Pt-to-Multi-Pt',
  PK: '3.45 GHz Service',
  PL: '3.5 GHz Band Priority Access License',
  PM: '3.7 GHz Service',
  PW: 'Public Safety Pool, Conventional',
  QA: '220-222 MHz Band, Auctioned',
  QD: 'Non-Nationwide Data, 220 MHz',
  QM: 'Non-Nationwide Public Safety/Mutual Aid, 220 MHz',
  QO: 'Non-Nationwide Other, 220 MHz',
  QQ: 'Intelligent Transportation Service (Non-Public Safety)',
  QT: 'Non-Nationwide 5 Channel Trunked, 220 MHz',
  RP: 'Broadcast Auxiliary Remote Pickup',
  RR: 'Restricted Operator',
  RS: 'Land Mobile Radiolocation',
  SA: 'Ship Recreational or Voluntarily Equipped',
  SB: 'Ship Compulsory Equipped',
  SE: 'Ship Exemption',
  SG: 'Conventional Public Safety 700 MHz',
  SL: 'Public Safety 700 MHZ Band-State License',
  SP: '700 MHz Public Safety Broadband Nationwide License',
  SY: 'Trunked Public Safety 700 MHz',
  TB: 'TV Microwave Booster',
  TC: 'MSS Ancillary Terrestrial Component (ATC) Leasing',
  TI: 'TV Intercity Relay',
  TN: '39 Ghz, Auctioned',
  TP: 'TV Pickup',
  TS: 'TV Studio Transmitter Link',
  TT: 'TV Translator Relay',
  TZ: '24 GHz Service',
  UM: 'Unlicensed Wireless Microphone Registration',
  UU: 'Upper Microwave Flexible Use Service',
  VX: 'Instructional Television Fixed Service',
  WA: 'Microwave Aviation',
  WM: 'Microwave Marine',
  WP: '700 MHz Upper Band (Block D)',
  WR: 'Microwave Radiolocation',
  WS: 'Wireless Communications Service',
  WT: '600 MHz Band',
  WU: '700 MHz Upper Band (Block C)',
  WX: '700 MHz Guard Band',
  WY: '700 MHz Lower Band (Blocks A, B & E)',
  WZ: '700 MHz Lower Band (Blocks C, D)',
  YB: 'Business, 806-821/851-866 MHz, Trunked',
  YC: 'SMR, 806-821/851-866 MHz, Auctioned',
  YD: 'SMR, 896-901/935-940 MHz, Auctioned',
  YE: 'PubSafty/SpecEmer/PubSaftyNtlPlan,806-817/851-862MHz,Trunked',
  YF: 'Public Safety Ntl Plan, 821-824/866-869 MHz, Trunked',
  YG: 'Industrial/Business Pool, Trunked',
  YH: 'SMR, 806-821/851-866 MHz, Auctioned (Rebanded YC license)',
  YI: 'Other Indust/Land Transp. 896-901/935-940 MHz, Trunked',
  YJ: 'Business/Industrial/Land Trans, 809-824/854-869 MHz, Trunked',
  YK: 'Industrial/Business Pool - Commercial, Trunked',
  YL: '900 MHz Trunked SMR (SMR, Site-Specific)',
  YM: '800 MHz Trunked SMR (SMR, Site-specific)',
  YO: 'Other Indust/Land Transp. 806-821/851-866 MHz, Trunked',
  YP: 'Public Safety/Spec Emerg, 806-821/851-866 MHz, Trunked',
  YS: 'SMR, 896-901/935-940 MHz, Trunked',
  YU: 'Business, 896-901/935-940 MHz, Trunked',
  YW: 'Public Safety Pool, Trunked',
  YX: 'SMR, 806-821/851-866 MHz, Trunked',
  ZA: 'General Mobile Radio (GMRS)',
  ZV: '218-219 MHz Service',
};

/** License status code → label (HD field 6). */
export const LICENSE_STATUSES: Readonly<Record<string, string>> = {
  A: 'Active',
  C: 'Canceled',
  E: 'Expired',
  L: 'Pending Legal Status',
  P: 'Parent Station Canceled',
  T: 'Terminated',
  X: 'Term Pending',
};

/** Location type code → label (LO field 7). */
export const LOCATION_TYPES: Readonly<Record<string, string>> = {
  '6': '6.1 meter control station',
  F: 'Fixed',
  I: 'Itinerant',
  L: 'Geographic Location',
  M: 'Mobile',
  P: 'P35 Centerpoint',
  T: 'Temporary Fixed',
};

/** Antenna type code → label (AN field 10). */
export const ANTENNA_TYPES: Readonly<Record<string, string>> = {
  H: 'Hub',
  P: 'Passive Repeater',
  R: 'Final Receiver',
  T: 'Transmit Antenna',
};

/** Applicant type code → label (EN field 24). `J` and `P` are marked inactive by the FCC. */
export const APPLICANT_TYPES: Readonly<Record<string, string>> = {
  B: 'Amateur Club',
  C: 'Corporation',
  D: 'General Partnership',
  E: 'Limited Partnership',
  F: 'Limited Liability Partnership',
  G: 'Governmental Entity',
  H: 'Other',
  I: 'Individual',
  J: 'Joint Venture',
  L: 'Limited Liability Company',
  M: 'Military Recreation',
  N: 'Tribal Entity',
  O: 'Consortium',
  P: 'Partnership',
  R: 'RACES',
  T: 'Trust',
  U: 'Unincorporated Association',
  Z: 'Tribal Entity Controlled by a Business',
};

/** Amateur operator class code → label (AM field 6). */
export const OPERATOR_CLASSES: Readonly<Record<string, string>> = {
  A: 'Advanced',
  E: 'Amateur Extra',
  G: 'General',
  N: 'Novice',
  P: 'Technician Plus',
  T: 'Technician',
};

/** USPS code → name for the 50 states, DC, and the five inhabited territories. */
export const USPS_STATES = {
  AL: 'Alabama',
  AK: 'Alaska',
  AZ: 'Arizona',
  AR: 'Arkansas',
  CA: 'California',
  CO: 'Colorado',
  CT: 'Connecticut',
  DE: 'Delaware',
  DC: 'District of Columbia',
  FL: 'Florida',
  GA: 'Georgia',
  HI: 'Hawaii',
  ID: 'Idaho',
  IL: 'Illinois',
  IN: 'Indiana',
  IA: 'Iowa',
  KS: 'Kansas',
  KY: 'Kentucky',
  LA: 'Louisiana',
  ME: 'Maine',
  MD: 'Maryland',
  MA: 'Massachusetts',
  MI: 'Michigan',
  MN: 'Minnesota',
  MS: 'Mississippi',
  MO: 'Missouri',
  MT: 'Montana',
  NE: 'Nebraska',
  NV: 'Nevada',
  NH: 'New Hampshire',
  NJ: 'New Jersey',
  NM: 'New Mexico',
  NY: 'New York',
  NC: 'North Carolina',
  ND: 'North Dakota',
  OH: 'Ohio',
  OK: 'Oklahoma',
  OR: 'Oregon',
  PA: 'Pennsylvania',
  RI: 'Rhode Island',
  SC: 'South Carolina',
  SD: 'South Dakota',
  TN: 'Tennessee',
  TX: 'Texas',
  UT: 'Utah',
  VT: 'Vermont',
  VA: 'Virginia',
  WA: 'Washington',
  WV: 'West Virginia',
  WI: 'Wisconsin',
  WY: 'Wyoming',
  AS: 'American Samoa',
  GU: 'Guam',
  MP: 'Northern Mariana Islands',
  PR: 'Puerto Rico',
  VI: 'U.S. Virgin Islands',
} as const;

/** A two-letter USPS state or territory code. */
export type UspsCode = keyof typeof USPS_STATES;

/** Every USPS code, in table order. */
export const USPS_CODES = Object.keys(USPS_STATES) as [UspsCode, ...UspsCode[]];

/** Lowercased, punctuation-free spelling used as the key of the full-name lookup. */
export function stateNameKey(name: string): string {
  return name.toLowerCase().replace(/[.,]/g, '').replace(/\s+/g, ' ').trim();
}

/** Full state or territory name (as keyed by {@link stateNameKey}) → USPS code. */
export const STATE_NAME_TO_CODE: ReadonlyMap<string, UspsCode> = new Map([
  ...(Object.entries(USPS_STATES) as [UspsCode, string][]).map(
    ([code, name]) => [stateNameKey(name), code] as const,
  ),
  ['virgin islands', 'VI'],
  ['us virgin islands', 'VI'],
  ['united states virgin islands', 'VI'],
  ['washington dc', 'DC'],
]);

/**
 * Weekly license snapshot groups (`complete/l_<group>.zip`) this server can ingest,
 * spelled as the FCC names the zips. `frc` (operator permits) is deliberately absent.
 */
export const SERVICE_GROUPS = [
  'LMpriv',
  'LMcomm',
  'LMbcast',
  'micro',
  'cell',
  'market',
  'paging',
  'coast',
  'mdsitfs',
  'amat',
  'gmrs',
  'ship',
  'aircr',
] as const;

/** A weekly service group name. */
export type ServiceGroup = (typeof SERVICE_GROUPS)[number];

/** Groups indexed when `FCC_SPECTRUM_SERVICES` is unset. */
export const DEFAULT_SERVICE_GROUPS: readonly ServiceGroup[] = [
  'LMpriv',
  'LMcomm',
  'LMbcast',
  'micro',
  'cell',
  'market',
  'paging',
  'coast',
  'mdsitfs',
  'amat',
];

/** Convert a code table to its entry list, in code order. */
export function toEntries(table: Readonly<Record<string, string>>): CodeEntry[] {
  return Object.entries(table)
    .map(([code, label]) => ({ code, label }))
    .sort((a, b) => a.code.localeCompare(b.code));
}
