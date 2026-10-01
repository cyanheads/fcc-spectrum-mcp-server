/**
 * @fileoverview Every tool definition this server registers.
 * @module mcp-server/tools/definitions
 */

import { findTransmitters } from './find-transmitters.tool.js';
import { getLicense } from './get-license.tool.js';
import { listReference } from './list-reference.tool.js';
import { searchFrequencies } from './search-frequencies.tool.js';
import { searchLicenses } from './search-licenses.tool.js';

/** Tools passed to `createApp()`. */
export const allToolDefinitions = [
  searchLicenses,
  getLicense,
  findTransmitters,
  searchFrequencies,
  listReference,
];
