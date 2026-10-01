/**
 * @fileoverview Point-in-polygon state lookup over the bundled Census cartographic
 * boundaries (`data/us-states.json`, 50 states, DC, and PR at 1:20,000,000). Each
 * polygon is prefiltered by its bounding box, then tested by ray casting with the
 * even-odd rule across its outer ring and holes. Used at ingest to derive a site's
 * state when the filing leaves it blank.
 * @module services/uls/state-lookup
 */

import boundaries from './data/us-states.json' with { type: 'json' };

interface IndexedPolygon {
  maxLat: number;
  maxLon: number;
  minLat: number;
  minLon: number;
  rings: number[][][];
  state: string;
}

const POLYGONS: IndexedPolygon[] = boundaries.features.flatMap((feature) =>
  feature.geometry.coordinates.map((rings) => {
    const outer = rings[0] ?? [];
    const lons = outer.map((point) => point[0] ?? 0);
    const lats = outer.map((point) => point[1] ?? 0);
    return {
      state: feature.properties.state,
      minLon: Math.min(...lons),
      minLat: Math.min(...lats),
      maxLon: Math.max(...lons),
      maxLat: Math.max(...lats),
      rings,
    };
  }),
);

function insideRings(rings: number[][][], lon: number, lat: number): boolean {
  let inside = false;
  for (const ring of rings) {
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
      const [xi = 0, yi = 0] = ring[i] ?? [];
      const [xj = 0, yj = 0] = ring[j] ?? [];
      if (yi > lat !== yj > lat && lon < ((xj - xi) * (lat - yi)) / (yj - yi) + xi) {
        inside = !inside;
      }
    }
  }
  return inside;
}

/**
 * The USPS code of the state, DC, or Puerto Rico containing a point, or `null` for a
 * point outside every boundary (offshore, or a territory other than PR). Near a border
 * the 1:20M generalization can place a point on the wrong side by about a kilometer.
 */
export function stateAt(latitude: number, longitude: number): string | null {
  for (const polygon of POLYGONS) {
    if (
      latitude < polygon.minLat ||
      latitude > polygon.maxLat ||
      longitude < polygon.minLon ||
      longitude > polygon.maxLon
    ) {
      continue;
    }
    if (insideRings(polygon.rings, longitude, latitude)) return polygon.state;
  }
  return null;
}
