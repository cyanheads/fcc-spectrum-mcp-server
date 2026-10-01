/**
 * @fileoverview Every resource definition this server registers.
 * @module mcp-server/resources/definitions
 */

import { licenseResource } from './license.resource.js';

/** Resources passed to `createApp()`. */
export const allResourceDefinitions = [licenseResource];
