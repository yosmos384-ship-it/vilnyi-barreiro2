// VILNYI · Barreiro 2 — ENVIRONMENT (agent: ENVIRONMENT) · phase 2: real OpenStreetMap + EU-DEM context
//
// export function buildEnvironment(THREE, { scene, renderer, quality:'high'|'low' }) => {
//   group, sun, hemi, setTimeOfDay('day'|'golden'|'dusk'), geo(lat, lon) => Vector3, update(dt, camera),
//   ready: Promise (resolves when data/osm.json is loaded and the real neighbourhood is built),
//   heightAt(x, z), timeOfDay, waterY, street, attribution
// }
//
// Local frame (see data.js SITE_FRAME): x along Rua Eduardo Couto (bearing 61.4°), -z towards the Tagus (bearing 331.4°),
// true north = (0.479, -0.878). Every geographic position goes through geoToLocal().
// Camera assumptions: near 0.05 … 1, far 30 000 … 60 000 m. The sky dome follows the camera, drawn without depth test.
// The river is a single plane drawn first without depth write, so land/water never z-fight at distance.
// Data: © OpenStreetMap contributors (ODbL) · EU-DEM (Copernicus), loaded at runtime from ../data/osm.json.

import { PROJECT, LOT, STREET, STREET_Y, LANDMARKS, SITE_FRAME, geoToLocal } from './data.js';

let T = null; // THREE namespace (set in buildEnvironment)

const DEG = Math.PI / 180;
const LAT0 = SITE_FRAME._lat0, LON0 = SITE_FRAME._lon0;
const M_LAT = 110540;
const M_LON = 111320 * Math.cos(LAT0 * DEG);
const NORTH = [SITE_FRAME.north.x, SITE_FRAME.north.z];   // true north in local (x, z)
const EAST = [-NORTH[1], NORTH[0]];                        // true east in local (x, z) = (0.878, 0.479)

export const WATER_Y = -12.7;     // Tagus mean level: ground floor is +12.70 m above sea level
const PAVE_Y = STREET_Y;          // -0.85 pavement at the site
const TERR_FLAT = STREET_Y - 0.13; // -0.98 yards level around the site (flattened zone)
const NEAR_Y = TERR_FLAT;
const ROAD_UP = 0.03;             // site street asphalt above flattened terrain (kerb 10 cm)
const PAVE_UP = 0.13;             // site pavements: TERR_FLAT + 0.13 = STREET_Y
const FAR_Y = -6;
const SINK = 2.0;
// Rua Eduardo Couto at the site (OSM centreline z = 23.8; the kerb of the lot is z = 17.4, the blocks opposite start at z = 26.8)
const SITE_ST = { x0: -40, x1: 42, paveN: [17.4, 20.0], road: [20.0, 25.6], paveS: [25.6, 26.8] };
const ROW_Z = (SITE_ST.road[0] + SITE_ST.road[1]) / 2, ROAD_HALF = (SITE_ST.road[1] - SITE_ST.road[0]) / 2, HALF = ROW_Z - SITE_ST.paveN[0];
// flattened zone around the site (terrain blends to TERR_FLAT)
const FLATZ = { x0: -45, x1: 60, z0: -40, z1: 45, fall: 45 };
// terrain grid levels (all lines at 7 + k·cell so the levels nest exactly)
const INNER = { c: 12, r: 1260 }, MID = { c: 45, r: 6300 }, OUTER = { c: 450, r: 27000 };
const NEARG = { x0: -53, x1: 67, z0: -29, z1: 55 };   // inner cells replaced by explicit flat ground (lot cut out)

// ---------------------------------------------------------------- small utils
function rngFrom(seed) {
  let a = seed >>> 0;
  return function () {
    a = (a + 0x6D2B79F5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const lerp = (a, b, t) => a + (b - a) * t;
const smooth = (e0, e1, x) => { const t = clamp((x - e0) / (e1 - e0), 0, 1); return t * t * (3 - 2 * t); };
const hash = (n) => { let x = (n | 0) * 374761393 + 668265263; x = (x ^ (x >>> 13)) * 1274126177; return ((x ^ (x >>> 16)) >>> 0) / 4294967296; };

// local x,z of a WGS84 position (array form)
export function geoXZ(lat, lon) { const p = geoToLocal(lat, lon); return [p.x, p.z]; }
// Phase-1 "old" frame (x = east, z = south, origin 7,7 at LAT0/LON0) — the far scenery is authored in it and mapped by FAR_XFORM
function oldToGeo(x, z) { return { lat: LAT0 - (z - 7) / M_LAT, lon: LON0 + (x - 7) / M_LON }; }
const _o0 = (() => { const g = oldToGeo(0, 0); return geoToLocal(g.lat, g.lon); })();
const FAR_XFORM = { tx: _o0.x, tz: _o0.z, ry: Math.atan2(EAST[1], EAST[0]) * -1 }; // Object3D.rotation.y maps +x to (cos, -sin)
function oldToLocal(x, z) { return [FAR_XFORM.tx + EAST[0] * x - NORTH[0] * z, FAR_XFORM.tz + EAST[1] * x - NORTH[1] * z]; }
function localToOld(x, z) { const dx = x - FAR_XFORM.tx, dz = z - FAR_XFORM.tz; return [dx * EAST[0] + dz * EAST[1], -(dx * NORTH[0] + dz * NORTH[1])]; }

// ---------------------------------------------------------------- land / water mask
// 520 × 520 cells of 25 m over local x,z ∈ [-6000, 7000], built offline from the OSM coastline + water polygons in osm.json
// (region growing from both sides of every coastline way). RLE varint, base64. 1 = land.
const MASK = { x0: -6000, z0: -6000, c: 25, n: 520 };
const MASK_B64 = '7wEChgQChgQChgQChgQChgQChgQChgQChgQChgQChgQChgQChgQChgQChgQChgQChgQChgQChgQChgQChgQChgQChgQChgQChgQChgQChgQChgQChgQChgQChgQChgQChgQChgQChgQChgQChgQChgQChgQChgQChgQChgQChgQChgQChwIQ7wEChgIR7wECgwIU7wECgQIW7wEC/gEZ7wEC+wEc7wEC+AEf7wEC9wEg7wEC9gEh7wEC9gEh7wEC9gEh7wECkAEhRSHvAQKOASs9Ie8BAogBMzsh7wECgQFANSHvAQJ6STMh7wECdFYsIe8BAnJZKyHvAQJwYCYh7wECbmchIe8BAm1vGiHvAQJsdxMh7wECansSIO8BAmiBARIc7wECZ4sBCRzvAQJmjwEGHO8BAmWRAQQd7wECYrUB7wECYrUB7wECYbYB7wECYLcB7wECX7gB7wECXrkB7wECXboB7wECXLsB7wECXLsB7wECW7wB7wECWr0B7wECWb4B7wECWL8B7wECV8AB7wECV8AB7wECVsEB7wECVcIB7wECVMMB7wECU8QB7wECUsUB7wECUcYB7wECUMcB7wECUMcB7wECT8gB7wECT8gB7wECTskB7wECTcoB7wECTMsB7wECTMsB7wECS8wB7wECSs0B7wECSs0B7wECSc4B7wECSM8B7wECSM8B7wECR9AB7wECR9AB7wECRtEB7wECRdIB7wECRdIB7wECRNMB7wECRNMB7wECQ9QB7wECQtUB7wECQhsCuAHvAQJBHAK4Ae8BAkEcArgB7wECQB0CuAHvAQJAHQK4Ae8BAj8eArgB7wECPh8CuAHvAQI+HwK4Ae8BAj0gArgB7wECPSACuAHvAQI8IQK4Ae8BAjsiArgB7wECOyICuAHvAQI6IwK4Ae8BAjojArgB7wECOSQCCQmmAe8BAjglAggOAgGfAe8BAjglAgcUnQHvAQI3JgIGFpwB7wECNyYCBhebAe8BAjYnAgUYmwHvAQI1KAIFGZoB7wECNCkCBQUMAQIFmgHvAQIzKgK4Ae8BAjMpBAMBswHvAQIyKgMEArIB7wECMSUCBAO4Ae8BAjAlBL4B7wECLyUHBxcGAQIBlAHvAQIuIy4CAZUB7wECLSExAgGVAe8BAiwhMpgB7wECKyE0BgOOAe8BAisgNgQEjgHvAQIqHzkDApAB7wECKh4/kAHvAQIqHUGPAe8BAiodRYsB7wECKh2cATTvAQIrHJwBNO8BAjIVnAE07wECNhGcATTvAQI8C5wBNO8BAuMBNO8BAuMBNO8BAuMBNO8BAuMBNO8BAuMBNO8BAuMBNO8BA+IBNPABAuIBNOQBAwgD4gE05AEO4gE05AEO4gE05AEO4gE05AEO4gE04wEP4gE04wEP4gE04wEP4wEz4wEO5QEy4wEIAgTnATDjAQgDA+gBL+MBCAMD6gEt4wEIAwPrASziAQILAu0BKuIBAgsC8AEn4gECCwLxASbiAQIKA/IBJeEBAwoD9AEj4QEFCAP1ASLgAQcHA/gBH+ABCwMD+QEe3wENAQP3AxH2AxK0Awk5EkoD5wIKNxNHB+4CEyUURgjvAisLFUYF8wIvBRdFBQMC7wIvARs9BQMEAwLvAi8BIDgGAwP1Ai4BLC0FAwKyAgRALQItLgMBBK4CEzMCASwCLTICpQIkIQIIBAIrAi3YAisaAwcEAysCKgEC2AIxFAQFBQQqAioBAtcCOA4GAwQFKgIt1gI/CA0FKgIt1gIJATUHDQYqAi3WAgcESAYqAi3WAgYFeAEu1QIEB3kBLtUCAwZ7AS7VAgIHDAJtAUHCAgIICwKvAcECAwgLAgoBowHCAgMICwIJA6EBwwIDCAsDCAOeAccCAggLAwgDnQHIAgMICgMIAwoBkQHKAggIBAMIAwoCjQHOAggGBQMIBAkCiAHUAgcCCQMIBJMB2QICAQgBDAWIAQMH2QIXBocBBAfZAgoBAgEIB4cBBAfaAgICBwQECYcBBAfaAgIDBQYCCocBBArXAgIDAxSGAQYJ/QE4IgIEAhSGAQYJ/QE4IgIFAhOIAQMK/QE4KQITigEBCv0BOCoBE44BAQb9ATg+jgEBBv0BOD+NAQEG/QE4LwULjQEBBv0BOC8GAgMFjQEBBv0BODAKBY0BAQaTAQVlODEJBowBAQaOAQxjODIHCYoBkwEQYThCigEiAmwUYDg9BAGJASMCaxVgODwFAYgBJAJqFmA4OwYBhwElAmkXYDg6BwGHASUCDwJXGGA4OQgBhwElAg8CVRpgODgJAYcBJQIPAlMcYDg3CgGHASUCDwJRHgqOATYLAYcBJQIPAk8gCo4BNQwBhwElAg8CTSIKjgE0DQGGASYCDwJLHwEDC44BM20CJScCDwJJIQEDC44BGhcBbgEmJwIPAkgiAwIKjgEaFwGVAScCDwJGJAIECY4BGxYCkwEoAg8CRSsJjgEcFQOSASgCDwJELAmOAR0UBJABKQIPAkMuCI4BHhMGjQEqAg8CQjAHjgEfEgeLASsCDwJBMgaOATleASsrAg8CQDMGjgE6XAIrKwIPAkA0BY8BOlwCKisCDwI/NQWQATqDAS8CDwI/NAeQASUCGAQCdy8CDwI+NQiRASMCH3YvAg8CPTYJkQEiAiB2LgIPAj03CZIBIAIgdi4CDwI8OQmTAR4CIXMBBCsCDwI7OgmUAR0CIXkqAg8COjsJlgEbAiJ4JwICCwEGOT0JlgEaAgkHEnglBAILAQY4PwiXARkCCAkReSQDAwIKBjdACJkBFwIICRJ4JQIDAgoGN0EHmwEVAgMEAQkSeDIDAQY2QgedARMCAwQBCRJ3GgsOAwEGNRgbEAefARECCAkTdRsLAwIDBQEDAQY0NAsFB6ABEAMHCRN1KQMCBQEDAQY0NQwCCKIBDgMHCRN1KQQDAwEDAQY0NhRRNR8KBAgJFHQqAwMDAQMBBjQ3ElI1IAkDCQkUdCoDAwcBBjQ4EFM1IxIJFXMqBAIHAQY0OA9UNSQRCRZyKQkGBi8EAjcHXDUkEQkWchMDEgkHBi4FAjcDYDUhFAkXcBMFEAgKBS4FBZcBNSITCRhrFgYQBwUDBAQuBQWXATUjEgkZahQIDwcFBAQDBwIlBQaXATUPCgoSCRppEwkPBwMGBAIFBiQFBZgBNQ8KCgMHCAkaahEKDggDBwUMIwQFmQE1DgsKAxgaawgDBAsLDwEFBA0iBAaZATUNGRkaawYSCxUEDyAEB5kBNQwbGBpsBRELDwEHAggBBx8FBpoBNQtPawUMDx4HBR4GBpoBNQoUBjdqBQsPFQQECQUdBwaaATUJFQc2awQKDxUGAwkFHAgGmgE1BRoGNW0CCg8UFAUcCAeZATYDVnkPFBUEHQUJmQE2Alh4DhY1BAuYAY8BeQ0YNAQLzwFYDwJmDxg1AgzQAVYQA2QRF0PUAQ4SMREDZBMRR9UBBBwwEQNkExFG9gEvEgRjERJH9gEvFgJhDxRI9QEuGAJgDhQPAjj1AS0aAWAOFA4EOPQBLBwBXw4TDAg39AEsHAFfDRMMCTjzASwdAV0OEwsKOfIBLB4CWw4SCg458AEsHwFbDhIKDzrvASt7DhMJEDruASt7DhQIEzjtASt7DRUFFzjsASp8BQIDGAQZN+wBKnwFOjfsASl9Bjo27AEofwU6NuwBJ4ABBTs26wECAiKAAQY7N+oBAQMigAEGOjntASGBAQY6OewBIYIBBTs56QEkgQEGODztAR+BAQYfAhc97QEeggEFIAEXPukBIoIBBDkIBTHpASGEAQI7Bw8DAiLpASCFAQI8BRECAiLpAR+HAQE8BBMBAiLpAR7EAQQXIukBHcUBBBci6QEcxAEHFyHpARvFAQcYIOkBGuUBIOkBGeYBIOkBGOcBH+oBF+gBHusBFukBHusBFeoBHewBFeoBHO0BFOsBG+4BFOsBGfABFOoBGPIBFOoBF/MBFOkBGPMBFgYB4AEY8wEe3wEY8wEh3AEZ8gEi2wEa8QEj2gEZ8wEj2QEY9AEj2QEX9QEi2wEOBAT1ASLbAQ4FA/UBItsBDv4BIdsBDYACINsBDYACINsBDYECH9wBDIECINsBDYACIdoBDv8BItkBDv8BI9gBDv8BJNgBDf8BJNgBDf8BJdgBDf4BJtgBDP4BJ9gBC/4BJ9kBC/0BJ9kBDPwBJ9kBDfsBJ9kBDvoBJ9kBD/oBJtkBEPkBJtkBpgFjJtoBEfcBJtsBEPcBJt8BDPcBJuABC/cBJuEBCvcBJuIBCfcBJeQBCPYBJuUBB/UBJ+UBB/QBKeUBBvMBK3kBawXzASx3AgIBagPzASx3AQMBagLrATXjAQLqATjkAQLpATnkAQTnATnkAQTnATjlAQTnATjkAQXlAQEENOUBBOwBM+UBBOwBMuYBBOgBAQMx5wEE6QEDAi7oAQTqAQEELegBA+sBAQUs6AEC7AEBBSvdAyreAynfAynfAyjgAyfhAybiAyXeAynfAyfiAybiAyXkAyPmAwICHO0DGe8DGPADF/EDF/EDF/EDF/ADF/ADF+8DGPADGPADGO8DGu4DGu4DG+0DHOwDDQ0C7AMNDQLrAx3rAxzsAxzsAxzsAx3rAx3rAx7rAx3rAx3sAxzsAx3tAxvvAxnxAxfyAxbyAxbyAxbrAwECAQIW8AMY6QMBBhjqAx7rAx3rAx3sAxzsAxzsAxzrAx3rAx3rAx3rAx3rAx3rAx3sAxzsAxvtAxvtAxruAxnvAxjwAxfxAxbyAxXzAxT0AxT0AxT0AxP1AxP1AxP0AxP1AxL2AxH3AxH3AxH3AxD5Aw76Awz8Awv9Awv9Awv9AwcCAvwDBwQB/AMGBQH8AwSFBAOGBAGOCAGFBAKGBAKGBAKGBAKGBAKHBAHIUA==';
let MASK_BITS = null;
function maskBits() {
  if (MASK_BITS) return MASK_BITS;
  const n = MASK.n, bits = new Uint8Array(n * n);
  try {
    const bin = typeof atob === 'function' ? atob(MASK_B64) : Buffer.from(MASK_B64, 'base64').toString('binary');
    let pos = 0, v = 0, k = 0;
    while (k < bin.length && pos < bits.length) {
      let r = 0, s = 0, b;
      do { b = bin.charCodeAt(k++); r |= (b & 127) << s; s += 7; } while (b & 128);
      if (v) bits.fill(1, pos, Math.min(bits.length, pos + r));
      pos += r; v ^= 1;
    }
  } catch (e) { /* all water */ }
  MASK_BITS = bits;
  return bits;
}
function maskAt(i, j) {
  const n = MASK.n;
  if (i < 0 || j < 0 || i >= n || j >= n) return -1;
  return maskBits()[j * n + i];
}
// land fraction 0..1 (bilinear), -1 when outside the mask domain
function landFrac(x, z) {
  const fx = (x - MASK.x0) / MASK.c - 0.5, fz = (z - MASK.z0) / MASK.c - 0.5;
  if (fx < 0 || fz < 0 || fx > MASK.n - 1 || fz > MASK.n - 1) return -1;
  const i = Math.floor(fx), j = Math.floor(fz), u = fx - i, v = fz - j;
  const a = maskAt(i, j), b = maskAt(i + 1, j), c = maskAt(i, j + 1), d = maskAt(i + 1, j + 1);
  return (a * (1 - u) + b * u) * (1 - v) + (c * (1 - u) + d * u) * v;
}

// ---------------------------------------------------------------- EU-DEM (from osm.json)
let DEM = null; // { N, step, x0, z0, h: Float32Array (NaN = water) }
function setDEM(t) {
  if (!t || !t.h) return;
  const h = new Float32Array(t.h.length);
  for (let i = 0; i < h.length; i++) h[i] = t.h[i] == null ? NaN : t.h[i];
  DEM = { N: t.N, step: t.step, x0: t.x0, z0: t.z0, h };
  _gh.clear();
}
function demAsl(x, z) { // metres above sea level, or null outside the grid
  if (!DEM) return null;
  const fx = (x - DEM.x0) / DEM.step, fz = (z - DEM.z0) / DEM.step, N = DEM.N;
  if (fx < 0 || fz < 0 || fx > N - 1 || fz > N - 1) return null;
  const i = Math.min(N - 2, Math.floor(fx)), j = Math.min(N - 2, Math.floor(fz)), u = fx - i, v = fz - j;
  const g = (a, b) => { const q = DEM.h[b * N + a]; return Number.isNaN(q) ? -1.5 : q; };
  return (g(i, j) * (1 - u) + g(i + 1, j) * u) * (1 - v) + (g(i, j + 1) * (1 - u) + g(i + 1, j + 1) * u) * v;
}
function demEdge(x, z) { // distance inside the DEM grid border (m)
  if (!DEM) return -1;
  const e = (DEM.N - 1) * DEM.step;
  return Math.min(x - DEM.x0, DEM.x0 + e - x, z - DEM.z0, DEM.z0 + e - z);
}

function vnoise(x, z) {
  return Math.sin(x * 0.0041 + 1.3) * Math.cos(z * 0.0033 - 0.4) + 0.5 * Math.sin(x * 0.011 - z * 0.009 + 2.0);
}

// ---------------------------------------------------------------- far land (outside the mask domain), authored in the old frame
function southPoly() {
  return [[-19300, 11000], [16000, 11000], [16000, -12400], [9400, -12370], [7575, -9610], [5053, -6625],
    [6445, -4193], [7300, -2000], [6500, 1500], [4500, 400], [-2950, -900], [-3100, 500], [-2750, 1240], [-2900, 1700],
    [-3600, 2300], [-4200, 3300], [-6000, 3000], [-6700, 1500], [-6670, 357], [-7600, -900], [-8575, -2403], [-9892, -1983],
    [-10760, -1420], [-12325, -867], [-17094, 7], [-19270, 900]];
}
const LISBON_POLY = [[-23000, -2300], [-16190, -2979], [-14450, -2757], [-11146, -3531], [-8797, -4083], [-7623, -4249],
  [-6305, -4968], [-4913, -6516], [-4305, -8174], [-3870, -10717], [-3783, -12596], [-4305, -14033], [-1870, -17902],
  [-1870, -22600], [-23000, -22600]];
let SOUTH_POLY = null;
function polySD(P, x, z) { // signed distance, + inside
  let inside = false, d2 = Infinity;
  for (let i = 0, j = P.length - 1; i < P.length; j = i++) {
    const [xi, zi] = P[i], [xj, zj] = P[j];
    if ((zi > z) !== (zj > z) && x < (xj - xi) * (z - zi) / (zj - zi) + xi) inside = !inside;
    const ex = xj - xi, ez = zj - zi, l2 = ex * ex + ez * ez || 1;
    const t = clamp(((x - xi) * ex + (z - zi) * ez) / l2, 0, 1);
    const dx = x - (xi + ex * t), dz = z - (zi + ez * t);
    d2 = Math.min(d2, dx * dx + dz * dz);
  }
  const d = Math.sqrt(d2);
  return inside ? d : -d;
}
// height (y) of far land in OLD-frame coordinates
function oldFarHeight(x, z) {
  if (!SOUTH_POLY) SOUTH_POLY = southPoly();
  const sd = polySD(SOUTH_POLY, x, z);
  if (sd > -400) {
    let h = FAR_Y + vnoise(x * 0.3, z * 0.3) * 4;
    if (x < -8500) h = WATER_Y + 1.2 + smooth(0, 280, sd) * 96 + vnoise(x, z) * 4 * smooth(0, 400, sd); // Almada cliffs
    return lerp(WATER_Y - 3, h, smooth(-8, 25, sd));
  }
  const ld = polySD(LISBON_POLY, x, z);
  if (ld > -400) {
    const h = WATER_Y + 2 + smooth(0, 1500, ld) * 85 + (vnoise(x * 0.6, z * 0.6) + 1) * 22 * smooth(0, 500, ld)
      + smooth(1500, 5000, ld) * 40 + (x < -13000 ? smooth(0, 2500, ld) * 110 : 0); // seven hills, Monsanto (W)
    return lerp(WATER_Y - 3, h, smooth(-8, 30, ld));
  }
  return WATER_Y - 3;
}

// ---------------------------------------------------------------- terrain height (y, local metres)
export function heightAt(x, z) {
  let y;
  const lf = landFrac(x, z);
  if (lf < 0) {
    const [xo, zo] = localToOld(x, z);
    y = oldFarHeight(xo, zo);
  } else {
    // mask domain: generic low land (Barreiro / Seixal / Moita plateaus 3–15 m asl) …
    const asl0 = 5 + (vnoise(x, z) + 1) * 3.5;
    let asl = asl0;
    // … replaced by the EU-DEM inside its grid (blended over 200 m at the grid border)
    const d = demAsl(x, z);
    if (d != null) asl = lerp(asl0, d, smooth(0, 200, demEdge(x, z)));
    const land = smooth(0.3, 0.7, lf);
    asl = lerp(-2.5, Math.max(asl, 1.0), land);
    y = asl - 12.7;
    // near the far-land model at the mask border
    const e = Math.min(x - MASK.x0, MASK.x0 + MASK.n * MASK.c - x, z - MASK.z0, MASK.z0 + MASK.n * MASK.c - z);
    if (e < 400) { const [xo, zo] = localToOld(x, z); y = lerp(oldFarHeight(xo, zo), y, smooth(0, 400, e)); }
  }
  // flatten the site's surroundings to the building's datum
  const dx = Math.max(FLATZ.x0 - x, 0, x - FLATZ.x1), dz = Math.max(FLATZ.z0 - z, 0, z - FLATZ.z1);
  const w = 1 - smooth(0, FLATZ.fall, Math.hypot(dx, dz));
  if (w > 0) y = lerp(y, TERR_FLAT, w);
  return y;
}

// Height of the rendered inner terrain mesh (same triangulation) — use to seat objects on the ground.
const _gh = new Map();
function gridH(i, j) {
  const k = i * 100003 + j;
  let v = _gh.get(k);
  if (v === undefined) { v = Math.max(WATER_Y + 0.02, heightAt(7 + i * INNER.c, 7 + j * INNER.c)); _gh.set(k, v); }
  return v;
}
export function groundY(x, z) {
  if (x > NEARG.x0 && x < NEARG.x1 && z > NEARG.z0 && z < NEARG.z1) return NEAR_Y;
  if (Math.abs(x - 7) > INNER.r || Math.abs(z - 7) > INNER.r) return heightAt(x, z);
  const fx = (x - 7) / INNER.c, fz = (z - 7) / INNER.c;
  const i = Math.floor(fx), j = Math.floor(fz), u = fx - i, v = fz - j;
  const a = gridH(i, j), b = gridH(i + 1, j), c = gridH(i, j + 1), d = gridH(i + 1, j + 1);
  if (u + v <= 1) return a + (b - a) * u + (c - a) * v;
  return d + (c - d) * (1 - u) + (b - d) * (1 - v);
}
export function isLand(x, z) { return heightAt(x, z) > WATER_Y + 0.5; }

// ---------------------------------------------------------------- geometry builder
const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const dot3 = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const norm3 = (a) => { const l = Math.hypot(a[0], a[1], a[2]) || 1; return [a[0] / l, a[1] / l, a[2] / l]; };

class GB {
  constructor() { this.p = []; this.n = []; this.u = []; this.c = []; this.col = [1, 1, 1]; this.fixUV = null; }
  plain(on = true) { this.fixUV = on ? [0.005, 0.9985] : null; return this; } // plain plaster texel of the façade atlas
  get empty() { return this.p.length === 0; }
  // arrays are sRGB 0..1 (like CSS), THREE.Color instances are used as-is (linear), strings/numbers parsed as sRGB hex
  color(c) {
    let k;
    if (c && c.isColor) k = c;
    else if (Array.isArray(c)) k = new T.Color().setRGB(c[0], c[1], c[2], T.SRGBColorSpace);
    else k = new T.Color(c);
    this.col = [k.r, k.g, k.b];
    return this;
  }
  _v(p, n, u) { if (this.fixUV) u = this.fixUV; this.p.push(p[0], p[1], p[2]); this.n.push(n[0], n[1], n[2]); this.u.push(u[0], u[1]); this.c.push(this.col[0], this.col[1], this.col[2]); }
  tri(a, b, c, ua = [0, 0], ub = [1, 0], uc = [0, 1], out) {
    let n = cross(sub(b, a), sub(c, a));
    if (out && dot3(n, out) < 0) { [b, c] = [c, b]; [ub, uc] = [uc, ub]; n = [-n[0], -n[1], -n[2]]; }
    n = norm3(n);
    this._v(a, n, ua); this._v(b, n, ub); this._v(c, n, uc);
  }
  quad(a, b, c, d, uvs, out) {
    uvs = uvs || [[0, 0], [1, 0], [1, 1], [0, 1]];
    const n = cross(sub(b, a), sub(c, a));
    if (out && dot3(n, out) < 0) { [a, b, c, d] = [d, c, b, a]; uvs = [uvs[3], uvs[2], uvs[1], uvs[0]]; }
    this.tri(a, b, c, uvs[0], uvs[1], uvs[2]);
    this.tri(a, c, d, uvs[0], uvs[2], uvs[3]);
  }
  // axis-aligned box with world-scaled uvs (s = metres per texture repeat)
  box(x0, y0, z0, x1, y1, z1, s = 1, skip = { bottom: true }) {
    const U = (a, b) => [a / s, b / s];
    if (!skip.top) this.quad([x0, y1, z0], [x1, y1, z0], [x1, y1, z1], [x0, y1, z1], [U(x0, z0), U(x1, z0), U(x1, z1), U(x0, z1)], [0, 1, 0]);
    if (!skip.bottom) this.quad([x0, y0, z0], [x1, y0, z0], [x1, y0, z1], [x0, y0, z1], [U(x0, z0), U(x1, z0), U(x1, z1), U(x0, z1)], [0, -1, 0]);
    if (!skip.px) this.quad([x1, y0, z0], [x1, y0, z1], [x1, y1, z1], [x1, y1, z0], [U(z0, y0), U(z1, y0), U(z1, y1), U(z0, y1)], [1, 0, 0]);
    if (!skip.nx) this.quad([x0, y0, z1], [x0, y0, z0], [x0, y1, z0], [x0, y1, z1], [U(z1, y0), U(z0, y0), U(z0, y1), U(z1, y1)], [-1, 0, 0]);
    if (!skip.pz) this.quad([x0, y0, z1], [x1, y0, z1], [x1, y1, z1], [x0, y1, z1], [U(x0, y0), U(x1, y0), U(x1, y1), U(x0, y1)], [0, 0, 1]);
    if (!skip.nz) this.quad([x1, y0, z0], [x0, y0, z0], [x0, y1, z0], [x1, y1, z0], [U(x1, y0), U(x0, y0), U(x0, y1), U(x1, y1)], [0, 0, -1]);
    return this;
  }
  // box centred at (cx, cz) rotated by ry around y
  rbox(cx, cz, w, d, y0, y1, ry, s = 1) {
    const g = new T.BoxGeometry(w, y1 - y0, d);
    const m = new T.Matrix4().makeRotationY(ry).setPosition(cx, (y0 + y1) / 2, cz);
    this.geom(g, m, s);
    g.dispose();
    return this;
  }
  geom(g, m, s = 1) {
    const gg = g.index ? g.toNonIndexed() : g;
    const P = gg.attributes.position, N = gg.attributes.normal, UV = gg.attributes.uv;
    const v = new T.Vector3(), nn = new T.Vector3();
    const nm = new T.Matrix3().getNormalMatrix(m || new T.Matrix4());
    for (let i = 0; i < P.count; i++) {
      v.fromBufferAttribute(P, i); if (m) v.applyMatrix4(m);
      if (N) { nn.fromBufferAttribute(N, i).applyMatrix3(nm).normalize(); } else nn.set(0, 1, 0);
      this.p.push(v.x, v.y, v.z); this.n.push(nn.x, nn.y, nn.z);
      if (this.fixUV) this.u.push(this.fixUV[0], this.fixUV[1]);
      else if (UV) this.u.push(UV.getX(i) / s, UV.getY(i) / s); else this.u.push(0, 0);
      this.c.push(this.col[0], this.col[1], this.col[2]);
    }
    if (gg !== g) gg.dispose();
    return this;
  }
  // transform vertices added since position-array index `start` (world matrix m)
  xform(start, m) {
    const v = new T.Vector3(), nn = new T.Vector3(), nm = new T.Matrix3().getNormalMatrix(m);
    for (let i = start; i < this.p.length; i += 3) {
      v.set(this.p[i], this.p[i + 1], this.p[i + 2]).applyMatrix4(m);
      this.p[i] = v.x; this.p[i + 1] = v.y; this.p[i + 2] = v.z;
      nn.set(this.n[i], this.n[i + 1], this.n[i + 2]).applyMatrix3(nm).normalize();
      this.n[i] = nn.x; this.n[i + 1] = nn.y; this.n[i + 2] = nn.z;
    }
    return this;
  }
  build() {
    const g = new T.BufferGeometry();
    g.setAttribute('position', new T.Float32BufferAttribute(this.p, 3));
    g.setAttribute('normal', new T.Float32BufferAttribute(this.n, 3));
    g.setAttribute('uv', new T.Float32BufferAttribute(this.u, 2));
    g.setAttribute('color', new T.Float32BufferAttribute(this.c, 3));
    g.computeBoundingSphere();
    return g;
  }
}

// ---------------------------------------------------------------- procedural canvas textures
function canvasTex(size, draw, { repeat = true, srgb = true, aniso = 8, h = size } = {}) {
  const c = document.createElement('canvas');
  c.width = size; c.height = h;
  const ctx = c.getContext('2d', { willReadFrequently: true });
  draw(ctx, size, h);
  const t = new T.CanvasTexture(c);
  if (srgb) t.colorSpace = T.SRGBColorSpace;
  if (repeat) { t.wrapS = t.wrapT = T.RepeatWrapping; }
  t.anisotropy = aniso;
  t.needsUpdate = true;
  return t;
}

function makeTextures(rng, aniso) {
  const tex = {};
  // Asphalt — 8 m tile
  tex.asphalt = canvasTex(512, (g, s) => {
    g.fillStyle = '#56575a'; g.fillRect(0, 0, s, s);
    for (let i = 0; i < 26000; i++) {
      const v = 60 + rng() * 70 | 0;
      g.fillStyle = `rgba(${v},${v},${v + 3},${0.35 + rng() * 0.4})`;
      g.fillRect(rng() * s, rng() * s, 1 + rng() * 1.6, 1 + rng() * 1.6);
    }
    for (let i = 0; i < 6; i++) { // soft repair patches
      const v = 70 + rng() * 25 | 0;
      g.fillStyle = `rgba(${v},${v},${v + 2},0.12)`;
      g.beginPath(); g.ellipse(rng() * s, rng() * s, 30 + rng() * 90, 15 + rng() * 40, rng() * 3, 0, Math.PI * 2); g.fill();
    }
    g.strokeStyle = 'rgba(28,28,30,0.55)'; g.lineWidth = 1.2;
    for (let i = 0; i < 9; i++) { // cracks
      let x = rng() * s, y = rng() * s; g.beginPath(); g.moveTo(x, y);
      for (let k = 0; k < 14; k++) { x += (rng() - 0.5) * 26; y += (rng() - 0.3) * 20; g.lineTo(x, y); }
      g.stroke();
    }
  }, { aniso });
  // White limestone calçada — 1.6 m tile, ~6.5 cm cubes laid in slightly irregular rows
  tex.calcada = canvasTex(512, (g, s) => {
    g.fillStyle = '#9a958b'; g.fillRect(0, 0, s, s);
    const n = 24, cs = s / n;
    for (let r = 0; r < n; r++) {
      const off = (r % 2) * cs * 0.5 + (rng() - 0.5) * 4;
      for (let c = -1; c <= n; c++) {
        const w = cs * (0.78 + rng() * 0.18), hh = cs * (0.78 + rng() * 0.18);
        const x = c * cs + off + (rng() - 0.5) * 2.5, y = r * cs + (rng() - 0.5) * 2.5;
        const v = 214 + rng() * 26 | 0, wv = rng() < 0.06 ? -40 : 0;
        g.fillStyle = `rgb(${v + wv},${v - 3 + wv},${v - 10 + wv})`;
        const rr = 3;
        g.beginPath();
        g.moveTo(x + rr, y); g.lineTo(x + w - rr, y); g.quadraticCurveTo(x + w, y, x + w, y + rr);
        g.lineTo(x + w, y + hh - rr); g.quadraticCurveTo(x + w, y + hh, x + w - rr, y + hh);
        g.lineTo(x + rr, y + hh); g.quadraticCurveTo(x, y + hh, x, y + hh - rr);
        g.lineTo(x, y + rr); g.quadraticCurveTo(x, y, x + rr, y); g.fill();
      }
    }
    for (let i = 0; i < 1400; i++) { g.fillStyle = `rgba(80,76,70,${rng() * 0.12})`; g.fillRect(rng() * s, rng() * s, 2, 2); }
  }, { aniso });
  // Rubble stone (garden wall bases) — 2 m tile
  tex.stone = canvasTex(256, (g, s) => {
    g.fillStyle = '#8c8578'; g.fillRect(0, 0, s, s);
    for (let i = 0; i < 90; i++) {
      const x = rng() * s, y = rng() * s, r = 10 + rng() * 16, v = 170 + rng() * 50 | 0;
      g.fillStyle = `rgb(${v},${v - 8},${v - 22})`;
      g.beginPath();
      for (let k = 0; k < 7; k++) { const a = k / 7 * Math.PI * 2; const rr = r * (0.7 + rng() * 0.4); g.lineTo(x + Math.cos(a) * rr, y + Math.sin(a) * rr * 0.75); }
      g.closePath(); g.fill();
    }
  }, { aniso });
  // Wrought-iron loops (balcony / gate), alpha
  tex.iron = canvasTex(256, (g, s, h) => {
    g.clearRect(0, 0, s, h);
    g.strokeStyle = '#ffffff'; g.lineWidth = 7;
    g.strokeRect(4, 4, s - 8, h - 8);
    g.lineWidth = 5;
    for (let i = 0; i < 4; i++) {
      const cx = (i + 0.5) * s / 4;
      g.beginPath(); g.ellipse(cx, h * 0.5, s / 9, h * 0.34, 0, 0, Math.PI * 2); g.stroke();
      g.beginPath(); g.moveTo(i * s / 4, 6); g.lineTo(i * s / 4, h - 6); g.stroke();
    }
  }, { aniso, srgb: true, h: 128 });
  // Green garden fence mesh, alpha
  tex.fence = canvasTex(128, (g, s) => {
    g.clearRect(0, 0, s, s);
    g.strokeStyle = '#2f5a3c'; g.lineWidth = 3;
    for (let i = 0; i <= 8; i++) { g.beginPath(); g.moveTo(i * s / 8, 0); g.lineTo(i * s / 8, s); g.stroke(); }
    g.lineWidth = 2;
    for (let i = 0; i <= 16; i++) { g.beginPath(); g.moveTo(0, i * s / 16); g.lineTo(s, i * s / 16); g.stroke(); }
    g.fillStyle = '#2f5a3c'; g.fillRect(0, 0, s, 8); g.fillRect(0, s - 8, s, 8);
  }, { aniso });
  // Terracotta roof tiles (canal tiles), white-ish so instance colour tints it
  tex.tiles = canvasTex(256, (g, s) => {
    g.fillStyle = '#f2f2f2'; g.fillRect(0, 0, s, s);
    const cols = 16, rows = 16;
    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < cols; c++) {
        const x = c * s / cols, y = r * s / rows;
        const grd = g.createLinearGradient(x, 0, x + s / cols, 0);
        const v = 0.86 + rng() * 0.14;
        grd.addColorStop(0, `rgba(0,0,0,${0.35})`);
        grd.addColorStop(0.5, `rgba(255,255,255,${0.15 * v})`);
        grd.addColorStop(1, `rgba(0,0,0,${0.35})`);
        g.fillStyle = grd; g.fillRect(x, y, s / cols, s / rows);
        g.fillStyle = `rgba(0,0,0,${0.25 + rng() * 0.2})`; g.fillRect(x, y + s / rows - 2, s / cols, 2);
        if (rng() < 0.08) { g.fillStyle = 'rgba(60,40,20,0.25)'; g.fillRect(x, y, s / cols, s / rows); }
      }
    }
  }, { aniso });
  // Dry yard / verge ground (earth, straw, weeds) — 6 m tile, tinted by vertex colour
  tex.yard = canvasTex(256, (g, s) => {
    g.fillStyle = '#bfb39c'; g.fillRect(0, 0, s, s);
    for (let i = 0; i < 5000; i++) {
      const t = rng();
      g.fillStyle = t < 0.5 ? `rgba(${150 + rng() * 60 | 0},${130 + rng() * 50 | 0},${80 + rng() * 40 | 0},0.5)` : t < 0.8 ? `rgba(${110 + rng() * 40 | 0},${115 + rng() * 40 | 0},${70 + rng() * 30 | 0},0.45)` : `rgba(90,80,65,0.35)`;
      g.fillRect(rng() * s, rng() * s, 1 + rng() * 3, 1 + rng() * 5);
    }
  }, { aniso });
  // Grey detail noise (linear, mean 0.5) for the ground shader
  tex.detail = canvasTex(256, (g, s) => {
    const img = g.createImageData(s, s);
    const v = new Float32Array(s * s);
    for (let o = 64; o >= 1; o >>= 1) { // value noise octaves, tileable
      const n = s / o, grid = []; for (let i = 0; i < n * n; i++) grid.push(rng());
      for (let y = 0; y < s; y++) for (let x = 0; x < s; x++) {
        const fx = x / o, fy = y / o, i = Math.floor(fx), j = Math.floor(fy), u = fx - i, w = fy - j;
        const G = (a, b) => grid[((b % n) * n) + (a % n)];
        const a = G(i, j) + (G(i + 1, j) - G(i, j)) * u, b = G(i, j + 1) + (G(i + 1, j + 1) - G(i, j + 1)) * u;
        v[y * s + x] += (a + (b - a) * w) * (o / 128);
      }
    }
    for (let i = 0; i < s * s; i++) {
      const r = clamp(v[i] * 0.9 + 0.05 + (rng() - 0.5) * 0.18, 0, 1), g2 = clamp(v[(i * 7) % (s * s)] * 0.9 + 0.05, 0, 1);
      img.data[i * 4] = r * 255; img.data[i * 4 + 1] = g2 * 255; img.data[i * 4 + 2] = r * 255; img.data[i * 4 + 3] = 255;
    }
    g.putImageData(img, 0, 0);
  }, { srgb: false, aniso });
  // Soft radial glow (street-lamp light pools, halos)
  tex.glow = canvasTex(128, (g, s) => {
    const grd = g.createRadialGradient(s / 2, s / 2, 0, s / 2, s / 2, s / 2);
    grd.addColorStop(0, 'rgba(255,255,255,1)'); grd.addColorStop(0.35, 'rgba(255,255,255,0.45)');
    grd.addColorStop(1, 'rgba(255,255,255,0)');
    g.fillStyle = grd; g.fillRect(0, 0, s, s);
  }, { repeat: false });
  return tex;
}

// ---------------------------------------------------------------- sky
// Gradient + sun + procedural cumulus dome. Outputs display colours without tone mapping so that the
// scene fog (applied after tone mapping in r160) can match its horizon colour exactly.
const SKY_VS = /* glsl */`
varying vec3 vDir;
void main() {
  vDir = normalize(position);
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); // radius 900 m, follows the camera
}`;
const SKY_FS = /* glsl */`
uniform vec3 zenith; uniform vec3 horizon; uniform vec3 horizonAway; uniform vec3 mid; uniform vec3 ground; uniform vec3 sunCol; uniform vec3 glowCol;
uniform vec3 sunDir; uniform float sunSize; uniform float cloudCover; uniform vec3 cloudLit; uniform vec3 cloudShade;
uniform float time; uniform float stars;
varying vec3 vDir;
float h21(vec2 p){ p = fract(p*vec2(123.34,456.21)); p += dot(p,p+45.32); return fract(p.x*p.y); }
float vn(vec2 p){ vec2 i=floor(p), f=fract(p); f=f*f*(3.0-2.0*f);
  return mix(mix(h21(i),h21(i+vec2(1,0)),f.x), mix(h21(i+vec2(0,1)),h21(i+vec2(1,1)),f.x), f.y); }
float fbm(vec2 p){ float a=0.5, s=0.0; for(int i=0;i<5;i++){ s+=a*vn(p); p=p*2.03+vec2(1.7,9.2); a*=0.5; } return s; }
void main() {
  vec3 d = normalize(vDir);
  float y = d.y;
  float sd = max(dot(d, sunDir), 0.0);
  vec2 hd = normalize(d.xz + 1e-5), hs = normalize(sunDir.xz + 1e-5);
  float toward = 0.5 + 0.5 * dot(hd, hs);
  vec3 hor = mix(horizonAway, horizon, pow(toward, 1.6));
  float yy = clamp(y, 0.0, 1.0);
  vec3 col = mix(hor, mid, smoothstep(0.0, 0.22, pow(yy, 0.8)));
  col = mix(col, zenith, smoothstep(0.12, 0.85, yy));
  // warm glow around the sun near the horizon
  float hz = 1.0 - smoothstep(0.0, 0.45, abs(y));
  col += glowCol * (pow(sd, 6.0) * 0.55 + pow(sd, 32.0) * 0.6) * (0.35 + 0.65 * hz);
  // below horizon: blend to ground haze
  col = mix(col, ground, smoothstep(0.0, -0.08, y));
  // clouds on a virtual plane
  if (y > 0.015 && cloudCover > 0.0) {
    vec2 uv = d.xz / (y + 0.08) * 1.3 + vec2(time * 0.004, time * 0.0016);
    float n = fbm(uv);
    float n2 = fbm(uv * 2.4 + 3.1);
    float c = smoothstep(1.0 - cloudCover, 1.0 - cloudCover + 0.28, n * 0.8 + n2 * 0.3);
    float shade = smoothstep(0.35, 0.9, n2);
    vec3 cc = mix(cloudLit, cloudShade, shade * 0.7);
    cc += glowCol * pow(sd, 4.0) * 0.5;
    float fade = smoothstep(0.015, 0.2, y);
    col = mix(col, cc, c * fade * 0.92);
  }
  // sun disc
  float disc = smoothstep(cos(sunSize), cos(sunSize * 0.6), dot(d, sunDir));
  col += sunCol * disc;
  // stars at dusk
  if (stars > 0.0 && y > 0.1) {
    vec2 g = d.xz / (y + 0.3) * 420.0;
    vec2 fg = fract(g) - 0.5;
    float s = step(0.9975, h21(floor(g))) * smoothstep(0.25, 0.7, y) * smoothstep(0.22, 0.05, length(fg)) * h21(floor(g) + 7.0);
    col += vec3(s) * stars;
  }
  gl_FragColor = vec4(col, 1.0);
  #include <colorspace_fragment>
}`;

function makeSky() {
  const mat = new T.ShaderMaterial({
    name: 'env-sky',
    uniforms: {
      zenith: { value: new T.Color() }, horizon: { value: new T.Color() }, horizonAway: { value: new T.Color() }, mid: { value: new T.Color() }, ground: { value: new T.Color() },
      sunCol: { value: new T.Color() }, glowCol: { value: new T.Color() }, sunDir: { value: new T.Vector3(0, 1, 0) },
      sunSize: { value: 0.012 }, cloudCover: { value: 0.35 }, cloudLit: { value: new T.Color() }, cloudShade: { value: new T.Color() },
      time: { value: 0 }, stars: { value: 0 }
    },
    vertexShader: SKY_VS, fragmentShader: SKY_FS,
    side: T.BackSide, depthWrite: false, depthTest: false, fog: false, toneMapped: false
  });
  const mesh = new T.Mesh(new T.SphereGeometry(900, 48, 24), mat);
  mesh.name = 'env-sky';
  mesh.frustumCulled = false;
  mesh.renderOrder = -1000;
  mesh.userData.noPick = true;
  return mesh;
}

// Time-of-day presets. Sun azimuth from north, clockwise; Lisbon 38.67°N, late September.
// 'day' ≈ 14:30 (az 200°, alt 47°), 'golden' ≈ 17:00 (az 234°, alt 24°: rakes along the SSE-facing street façade from the
// left, as in the renders; any later sun leaves that façade in shade), 'dusk' ≈ sunset (az 268°, alt 3°).
const TOD = {
  day: {
    az: 200, alt: 47, sun: '#fff4e6', sunI: 3.4,
    zenith: '#2f6fc0', mid: '#79a6dc', horizon: '#d6e3ef', away: '#c3d7ec', fogCol: '#c9d9e8', ground: '#b9c6cf', glow: '#fff3d8', sunDisc: 6.0,
    cloud: 0.36, cloudLit: '#ffffff', cloudShade: '#aeb8c6',
    hemiSky: '#bcd6f0', hemiGround: '#b59e82', hemiI: 0.55, env: 0.9,
    fog: 0.000055, exposure: 1.0, lamps: 0, city: 0, stars: 0, water: '#3f6f8f', waterSky: '#9fc0dc'
  },
  golden: {
    az: 234, alt: 24, sun: '#ffb574', sunI: 3.6,
    zenith: '#3b6db0', mid: '#86a9d0', horizon: '#f6cf9f', away: '#c8d3df', fogCol: '#d9d5cf', ground: '#c9b39b', glow: '#ffb66a', sunDisc: 5.0,
    cloud: 0.28, cloudLit: '#fff0dc', cloudShade: '#a9a2a8',
    hemiSky: '#b9c8e0', hemiGround: '#b08e6c', hemiI: 0.4, env: 0.6,
    fog: 0.000065, exposure: 1.0, lamps: 0, city: 0.15, stars: 0, water: '#3c5f7a', waterSky: '#d9c3a8'
  },
  dusk: {
    az: 268, alt: 3, sun: '#ff9a6a', sunI: 0.35,
    zenith: '#1b2748', mid: '#46557e', horizon: '#ee9a6c', away: '#8b8aa3', fogCol: '#77738a', ground: '#3a3c4a', glow: '#ff8a55', sunDisc: 0.0,
    cloud: 0.18, cloudLit: '#f0a283', cloudShade: '#4a4a62',
    hemiSky: '#5a6c9a', hemiGround: '#3e3136', hemiI: 0.35, env: 0.25,
    fog: 0.00007, exposure: 1.0, lamps: 1, city: 1, stars: 0.5, water: '#1b2438', waterSky: '#6b5a70'
  }
};

export function sunDirection(az, alt) {
  // compass azimuth (from true north, clockwise) → local frame (north = SITE_FRAME.north, east = its clockwise normal)
  const a = az * DEG, e = alt * DEG, sa = Math.sin(a), ca = Math.cos(a);
  const x = sa * EAST[0] + ca * NORTH[0], z = sa * EAST[1] + ca * NORTH[1];
  return new T.Vector3(x * Math.cos(e), Math.sin(e), z * Math.cos(e)).normalize();
}

// ---------------------------------------------------------------- water
const WATER_VS = /* glsl */`
varying vec3 vWorld;
#include <fog_pars_vertex>
void main() {
  vec4 wp = modelMatrix * vec4(position, 1.0);
  vWorld = wp.xyz;
  vec4 mvPosition = viewMatrix * wp;
  gl_Position = projectionMatrix * mvPosition;
  #include <fog_vertex>
}`;
const WATER_FS = /* glsl */`
uniform float time; uniform vec3 deep; uniform vec3 skyLow; uniform vec3 skyHigh; uniform vec3 sunCol; uniform vec3 sunDir;
uniform float lights;
varying vec3 vWorld;
#include <fog_pars_fragment>
float h21(vec2 p){ p = fract(p*vec2(123.34,456.21)); p += dot(p,p+45.32); return fract(p.x*p.y); }
float vn(vec2 p){ vec2 i=floor(p), f=fract(p); f=f*f*(3.0-2.0*f);
  return mix(mix(h21(i),h21(i+vec2(1,0)),f.x), mix(h21(i+vec2(0,1)),h21(i+vec2(1,1)),f.x), f.y); }
vec2 grad(vec2 p){ float e = 0.35; return vec2(vn(p+vec2(e,0.0))-vn(p-vec2(e,0.0)), vn(p+vec2(0.0,e))-vn(p-vec2(0.0,e))) / (2.0*e); }
void main() {
  vec3 V = cameraPosition - vWorld;
  float dist = length(V); V /= dist;
  vec2 p = vWorld.xz;
  float fade = 1.0 / (1.0 + dist * 0.004);
  vec2 g = grad(p * 0.09 + vec2(time * 0.21, time * 0.13)) * 0.55
         + grad(p * 0.23 + vec2(-time * 0.33, time * 0.27)) * 0.3
         + grad(p * 0.021 + vec2(time * 0.05, -time * 0.04)) * 0.6;
  float amp = 0.22 * (0.12 + 0.88 * fade);
  vec3 N = normalize(vec3(-g.x * amp, 1.0, -g.y * amp));
  vec3 R = reflect(-V, N);
  float fres = 0.02 + 0.98 * pow(1.0 - max(dot(N, V), 0.0), 5.0);
  vec3 sky = mix(skyLow, skyHigh, pow(clamp(R.y, 0.0, 1.0), 0.5));
  vec3 col = mix(deep, sky, clamp(fres * 1.15, 0.0, 1.0));
  float s = max(dot(R, sunDir), 0.0);
  col += sunCol * (pow(s, 900.0) * 6.0 + pow(s, 120.0) * 0.35);
  // dusk: shimmering reflections of the far shore lights
  if (lights > 0.0) {
    float band = smoothstep(-2600.0, -8000.0, vWorld.z) * smoothstep(0.0, 0.06, fres);
    float sp = step(0.985, vn(vec2(vWorld.x * 0.05, vWorld.z * 0.004 + time * 0.8)));
    col += vec3(1.0, 0.78, 0.45) * sp * band * lights * 0.6;
  }
  gl_FragColor = vec4(col, 1.0);
  #include <colorspace_fragment>
  #include <fog_fragment>
}`;

function buildWater(C) {
  const mat = new T.ShaderMaterial({
    name: 'env-water',
    uniforms: T.UniformsUtils.merge([T.UniformsLib.fog, {
      time: { value: 0 }, deep: { value: new T.Color('#3f6f8f') }, skyLow: { value: new T.Color('#c9dcef') },
      skyHigh: { value: new T.Color('#5d8fc9') }, sunCol: { value: new T.Color('#fff4e6') }, sunDir: { value: new T.Vector3(0, 1, 0) },
      lights: { value: 0 }
    }]),
    vertexShader: WATER_VS, fragmentShader: WATER_FS, fog: true, toneMapped: false,
    depthWrite: false // drawn first (renderOrder); land drawn after always wins → no z-fighting at 10 km
  });
  C.mats.water = mat;
  const g = new T.PlaneGeometry(70000, 60000, 1, 1).rotateX(-Math.PI / 2);
  const m = new T.Mesh(g, mat);
  m.position.set(-4000, WATER_Y, -8000);
  m.name = 'env-tagus';
  m.renderOrder = -10;
  return m;
}

// ---------------------------------------------------------------- façade textures (windows with roller shutters)
// One tile = 4 bays (3.2 m) × 4 storeys (3 m). Walls are tinted by vertex colour.
const BAY = 3.2, STOREY = 3.0, TILE_U = 4 * BAY, TILE_V = 4 * STOREY;
function makeFacadeTextures(rng, size, aniso) {
  const layout = [];
  for (let r = 0; r < 4; r++) for (let c = 0; c < 4; c++) {
    const kind = rng() < 0.18 ? 'door' : rng() < 0.25 ? 'wide' : 'win';
    layout.push({ r, c, kind: r === 3 && kind === 'door' ? 'door' : (kind === 'door' ? 'win' : kind), shutter: rng() * 0.75, lit: rng() < 0.42, warm: rng() });
  }
  const px = size / 16; // pixels per 0.8 m unit (bay = 4 units, storey = 3.75 units)
  const bw = size / 4, sh = size / 4;
  const rectOf = (L) => {
    const x0 = L.c * bw, y0 = L.r * sh; // canvas y down: row 0 = top storey
    let w = L.kind === 'wide' ? 0.62 : L.kind === 'door' ? 0.36 : 0.40;
    const x = x0 + bw * (0.5 - w / 2), W = bw * w;
    const top = y0 + sh * (L.kind === 'door' ? 0.22 : 0.22), bot = y0 + sh * (L.kind === 'door' ? 0.98 : 0.72);
    return { x, y: top, w: W, h: bot - top };
  };
  const map = canvasTex(size, (g, s) => {
    g.fillStyle = '#f4f2ee'; g.fillRect(0, 0, s, s);
    // subtle plaster noise & dirt streaks
    for (let i = 0; i < 9000; i++) { const v = 225 + rng() * 30 | 0; g.fillStyle = `rgba(${v},${v},${v - 4},0.25)`; g.fillRect(rng() * s, rng() * s, 2, 2); }
    for (let r = 0; r < 4; r++) { // storey bands (slab edges)
      g.fillStyle = 'rgba(0,0,0,0.05)'; g.fillRect(0, r * sh + sh - 3, s, 3);
    }
    for (const L of layout) {
      const R = rectOf(L);
      // frame
      g.fillStyle = '#e9e6df'; g.fillRect(R.x - px * 0.12, R.y - px * 0.12, R.w + px * 0.24, R.h + px * 0.24);
      // glass
      const grd = g.createLinearGradient(0, R.y, 0, R.y + R.h);
      grd.addColorStop(0, '#2a3440'); grd.addColorStop(1, '#475563');
      g.fillStyle = grd; g.fillRect(R.x, R.y, R.w, R.h);
      g.fillStyle = 'rgba(255,255,255,0.10)'; g.fillRect(R.x, R.y, R.w * 0.5, R.h);
      // mullion
      g.fillStyle = '#d8d4cc'; g.fillRect(R.x + R.w / 2 - 1.5, R.y, 3, R.h);
      // roller shutter (estore) with box
      const shH = R.h * L.shutter;
      g.fillStyle = '#d9d5cc'; g.fillRect(R.x, R.y, R.w, shH);
      g.fillStyle = 'rgba(0,0,0,0.12)';
      for (let y = R.y; y < R.y + shH; y += 4) g.fillRect(R.x, y, R.w, 1);
      g.fillStyle = '#ccc7bd'; g.fillRect(R.x - px * 0.12, R.y - px * 0.34, R.w + px * 0.24, px * 0.24);
      // sill
      if (L.kind !== 'door') { g.fillStyle = '#fbfaf7'; g.fillRect(R.x - px * 0.25, R.y + R.h, R.w + px * 0.5, px * 0.14); g.fillStyle = 'rgba(0,0,0,0.18)'; g.fillRect(R.x - px * 0.2, R.y + R.h + px * 0.14, R.w + px * 0.4, px * 0.08); }
    }
  }, { aniso });
  const lit = canvasTex(size, (g, s) => {
    g.fillStyle = '#000'; g.fillRect(0, 0, s, s);
    for (const L of layout) {
      if (!L.lit) continue;
      const R = rectOf(L);
      const y0 = R.y + R.h * L.shutter;
      g.fillStyle = L.warm < 0.75 ? '#ffc27a' : '#dfe6ff';
      g.globalAlpha = 0.55 + L.warm * 0.45;
      g.fillRect(R.x, y0, R.w, R.y + R.h - y0);
      g.globalAlpha = 1;
    }
  }, { aniso });
  return { map, lit };
}

// ---------------------------------------------------------------- building primitives (merged)
// Wall box with façade UVs: base = ground level of the building (windows start there)
function facadeBox(gb, x0, z0, x1, z1, base, top, sink = SINK, uoff = 0) {
  const bays = (len) => Math.max(1, Math.round(len / BAY));
  const storeys = Math.max(1, Math.round((top - base) / STOREY));
  const vs = (y) => (y - base) / ((top - base) / storeys) / 4;
  const y0 = base - sink;
  const P = [[0.004, 0.998], [0.006, 0.998], [0.006, 0.999], [0.004, 0.999]]; // plain plaster texel
  const face = (ax, az, bx, bz, out) => {
    const len = Math.hypot(bx - ax, bz - az), nb = bays(len) / 4;
    gb.quad([ax, base, az], [bx, base, bz], [bx, top, bz], [ax, top, az], [[uoff, 0], [uoff + nb, 0], [uoff + nb, vs(top)], [uoff, vs(top)]], out);
    if (sink > 0) gb.quad([ax, y0, az], [bx, y0, bz], [bx, base, bz], [ax, base, az], P, out);
  };
  face(x0, z1, x1, z1, [0, 0, 1]);
  face(x1, z0, x0, z0, [0, 0, -1]);
  face(x1, z1, x1, z0, [1, 0, 0]);
  face(x0, z0, x0, z1, [-1, 0, 0]);
}
// Hipped tile roof over rectangle (with overhang), world-scaled uv (tile texture 3 m)
function hipRoof(gb, x0, z0, x1, z1, y, pitch = 0.45, ov = 0.35) {
  x0 -= ov; z0 -= ov; x1 += ov; z1 += ov;
  const w = x1 - x0, d = z1 - z0, cx = (x0 + x1) / 2, cz = (z0 + z1) / 2;
  const rh = Math.min(w, d) / 2 * pitch;
  const S = 3;
  if (w >= d) {
    const r0 = [x0 + d / 2, y + rh, cz], r1 = [x1 - d / 2, y + rh, cz];
    const sl = Math.hypot(d / 2, rh) / S;
    gb.quad([x0, y, z1], [x1, y, z1], r1, r0, [[x0 / S, 0], [x1 / S, 0], [r1[0] / S, sl], [r0[0] / S, sl]], [0, 1, 1]);
    gb.quad([x1, y, z0], [x0, y, z0], r0, r1, [[-x1 / S, 0], [-x0 / S, 0], [-r0[0] / S, sl], [-r1[0] / S, sl]], [0, 1, -1]);
    gb.tri([x1, y, z1], [x1, y, z0], r1, [z1 / S, 0], [z0 / S, 0], [cz / S, sl], [1, 1, 0]);
    gb.tri([x0, y, z0], [x0, y, z1], r0, [z0 / S, 0], [z1 / S, 0], [cz / S, sl], [-1, 1, 0]);
  } else {
    const r0 = [cx, y + rh, z0 + w / 2], r1 = [cx, y + rh, z1 - w / 2];
    const sl = Math.hypot(w / 2, rh) / S;
    gb.quad([x1, y, z1], [x1, y, z0], r0, r1, [[z1 / S, 0], [z0 / S, 0], [r0[2] / S, sl], [r1[2] / S, sl]], [1, 1, 0]);
    gb.quad([x0, y, z0], [x0, y, z1], r1, r0, [[z0 / S, 0], [z1 / S, 0], [r1[2] / S, sl], [r0[2] / S, sl]], [-1, 1, 0]);
    gb.tri([x0, y, z1], [x1, y, z1], r1, [x0 / S, 0], [x1 / S, 0], [cx / S, sl], [0, 1, 1]);
    gb.tri([x1, y, z0], [x0, y, z0], r0, [x1 / S, 0], [x0 / S, 0], [cx / S, sl], [0, 1, -1]);
  }
  return rh;
}
// Gable roof, ridge along x (alongX) or z
function gableRoof(gb, x0, z0, x1, z1, y, alongX, pitch = 0.5, ov = 0.35, gableCol) {
  x0 -= ov; z0 -= ov; x1 += ov; z1 += ov;
  const S = 3;
  if (alongX) {
    const cz = (z0 + z1) / 2, rh = (z1 - z0) / 2 * pitch, sl = Math.hypot((z1 - z0) / 2, rh) / S;
    gb.quad([x0, y, z1], [x1, y, z1], [x1, y + rh, cz], [x0, y + rh, cz], [[x0 / S, 0], [x1 / S, 0], [x1 / S, sl], [x0 / S, sl]], [0, 1, 1]);
    gb.quad([x1, y, z0], [x0, y, z0], [x0, y + rh, cz], [x1, y + rh, cz], [[-x1 / S, 0], [-x0 / S, 0], [-x0 / S, sl], [-x1 / S, sl]], [0, 1, -1]);
    return rh;
  }
  const cx = (x0 + x1) / 2, rh = (x1 - x0) / 2 * pitch, sl = Math.hypot((x1 - x0) / 2, rh) / S;
  gb.quad([x1, y, z1], [x1, y, z0], [cx, y + rh, z0], [cx, y + rh, z1], [[z1 / S, 0], [z0 / S, 0], [z0 / S, sl], [z1 / S, sl]], [1, 1, 0]);
  gb.quad([x0, y, z0], [x0, y, z1], [cx, y + rh, z1], [cx, y + rh, z0], [[z0 / S, 0], [z1 / S, 0], [z1 / S, sl], [z0 / S, sl]], [-1, 1, 0]);
  return rh;
}
// Gable-end triangles (wall material) for gableRoof
function gableEnds(gb, x0, z0, x1, z1, y, alongX, pitch = 0.5) {
  if (alongX) {
    const cz = (z0 + z1) / 2, rh = (z1 - z0) / 2 * (pitch) * ((z1 - z0) / 2) / ((z1 - z0) / 2);
    gb.tri([x0, y, z0], [x0, y, z1], [x0, y + rh, cz], [0, 0], [1, 0], [0.5, 0.5], [-1, 0, 0]);
    gb.tri([x1, y, z1], [x1, y, z0], [x1, y + rh, cz], [0, 0], [1, 0], [0.5, 0.5], [1, 0, 0]);
  } else {
    const cx = (x0 + x1) / 2, rh = (x1 - x0) / 2 * pitch;
    gb.tri([x0, y, z1], [x1, y, z1], [cx, y + rh, z1], [0, 0], [1, 0], [0.5, 0.5], [0, 0, 1]);
    gb.tri([x1, y, z0], [x0, y, z0], [cx, y + rh, z0], [0, 0], [1, 0], [0.5, 0.5], [0, 0, -1]);
  }
}

// ---------------------------------------------------------------- chunked merged-geometry collector
class Chunks {
  constructor(size = 200) { this.size = size; this.map = new Map(); }
  gb(x, z, key) {
    const k = `${key}|${Math.floor(x / this.size)}|${Math.floor(z / this.size)}`;
    let g = this.map.get(k);
    if (!g) { g = new GB(); this.map.set(k, g); }
    return g;
  }
  meshes(mats, parent, { cast = () => false, receive = true } = {}) {
    for (const [k, gb] of this.map) {
      if (gb.empty) continue;
      const [key] = k.split('|');
      const m = new T.Mesh(gb.build(), mats[key]);
      m.name = `env-${key}-${k.split('|').slice(1).join('_')}`;
      m.castShadow = cast(m);
      m.receiveShadow = receive;
      m.matrixAutoUpdate = false;
      m.updateMatrix();
      parent.add(m);
    }
    this.map.clear();
  }
}

const HOUSE_COLS = ['#f4f1ea', '#f6f2e6', '#efe7d6', '#f1d9c6', '#e9c9b3', '#f3e3b8', '#e6e2d8', '#dfe3e2', '#f5efe0', '#eed8cf', '#f6f4ef', '#e8d8b8'];
const BLOCK_COLS = ['#efe4cf', '#e7cdbd', '#eadcc4', '#f1ead9', '#e4c7b5', '#ddd4c3'];
const ROOF_COLS = ['#b5563a', '#a94d33', '#c0613f', '#9c4a34', '#b8603f', '#a8583b'];

// ---------------------------------------------------------------- materials
function makeMaterials(C, tex, fac) {
  const M = C.mats;
  M.facade = new T.MeshStandardMaterial({ name: 'env-facade', map: fac.map, vertexColors: true, roughness: 0.88, metalness: 0,
    emissive: new T.Color('#ffffff'), emissiveMap: fac.lit, emissiveIntensity: 0, envMapIntensity: 0.7 });
  M.city = new T.MeshStandardMaterial({ name: 'env-city', map: fac.map, vertexColors: true, roughness: 0.9, metalness: 0,
    emissive: new T.Color('#ffffff'), emissiveMap: fac.lit, emissiveIntensity: 0, envMapIntensity: 0.5 });
  M.roof = new T.MeshStandardMaterial({ name: 'env-roof', map: tex.tiles, vertexColors: true, roughness: 0.78, metalness: 0, envMapIntensity: 0.6 });
  M.plain = new T.MeshStandardMaterial({ name: 'env-plain', vertexColors: true, roughness: 0.85, metalness: 0, envMapIntensity: 0.7 });
  M.metal = new T.MeshStandardMaterial({ name: 'env-metal', vertexColors: true, roughness: 0.45, metalness: 0.6, envMapIntensity: 0.9 });
  M.asphalt = new T.MeshStandardMaterial({ name: 'env-asphalt', map: tex.asphalt, color: '#ffffff', roughness: 0.94, metalness: 0, envMapIntensity: 0.5 });
  M.calcada = new T.MeshStandardMaterial({ name: 'env-calcada', map: tex.calcada, color: '#ffffff', roughness: 0.8, metalness: 0, envMapIntensity: 0.6 });
  for (const m of [M.asphalt, M.calcada]) Object.assign(m, { polygonOffset: true, polygonOffsetFactor: -1, polygonOffsetUnits: -2 });
  M.dirt = new T.MeshStandardMaterial({ name: 'env-dirt', map: tex.yard, color: '#d9cbb0', roughness: 1, envMapIntensity: 0.5,
    polygonOffset: true, polygonOffsetFactor: -1, polygonOffsetUnits: -1 });
  M.terrain = new T.MeshStandardMaterial({ name: 'env-terrain', vertexColors: true, roughness: 1, metalness: 0, envMapIntensity: 0.55 });
  // inner terrain + site ground: painted landuse map (2.5 m/px) × a tiling detail texture in world space
  M.terrainInner = new T.MeshStandardMaterial({ name: 'env-ground', color: '#ffffff', roughness: 1, metalness: 0, envMapIntensity: 0.55 });
  M.terrainInner.onBeforeCompile = (sh) => {
    sh.uniforms.detailMap = { value: tex.detail };
    sh.vertexShader = sh.vertexShader.replace('#include <common>', '#include <common>\nvarying vec2 vWXZ;')
      .replace('#include <begin_vertex>', '#include <begin_vertex>\nvWXZ = (modelMatrix * vec4(transformed, 1.0)).xz;');
    sh.fragmentShader = sh.fragmentShader.replace('#include <common>', '#include <common>\nuniform sampler2D detailMap;\nvarying vec2 vWXZ;')
      .replace('#include <map_fragment>', `#include <map_fragment>
        float d1 = texture2D(detailMap, vWXZ / 3.1).r, d2 = texture2D(detailMap, vWXZ / 23.0 + 0.37).g;
        diffuseColor.rgb *= 0.55 + 0.9 * (0.6 * d1 + 0.4 * d2);`);
  };
  M.terrainInner.customProgramCacheKey = () => 'env-ground-detail';
  M.ground = M.terrainInner;
  M.stone = new T.MeshStandardMaterial({ name: 'env-stone', map: tex.stone, color: '#ffffff', roughness: 0.9, envMapIntensity: 0.6 });
  M.yard = new T.MeshStandardMaterial({ name: 'env-yard', map: tex.yard, vertexColors: true, roughness: 1, envMapIntensity: 0.5 });
  M.iron = new T.MeshStandardMaterial({ name: 'env-iron', map: tex.iron, color: '#f2f2ee', alphaTest: 0.5, side: T.DoubleSide, roughness: 0.6, metalness: 0.2 });
  M.fence = new T.MeshStandardMaterial({ name: 'env-fence', map: tex.fence, color: '#ffffff', alphaTest: 0.5, side: T.DoubleSide, roughness: 0.7 });
  M.glassDark = new T.MeshStandardMaterial({ name: 'env-window', color: '#28313a', roughness: 0.08, metalness: 0.2, envMapIntensity: 1.2,
    emissive: new T.Color('#ffb56b'), emissiveIntensity: 0 });
  M.lampHead = new T.MeshStandardMaterial({ name: 'env-lamp', color: '#e8e6e0', emissive: new T.Color('#ffc98a'), emissiveIntensity: 0, roughness: 0.3 });
  M.cable = new T.LineBasicMaterial({ name: 'env-cable', color: '#202224', transparent: true, opacity: 0.85 });
  M.glow = new T.MeshBasicMaterial({ name: 'env-glow', map: tex.glow, color: '#ffb870', transparent: true, opacity: 0, depthWrite: false,
    blending: T.AdditiveBlending, toneMapped: false });
  M.pool = new T.MeshBasicMaterial({ name: 'env-lightpool', map: tex.glow, color: '#ffae62', transparent: true, opacity: 0, depthWrite: false,
    blending: T.AdditiveBlending, toneMapped: false, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -4 });
  M.tree = new T.MeshStandardMaterial({ name: 'env-tree', vertexColors: true, roughness: 0.95, flatShading: true, envMapIntensity: 0.5 });
  M.car = new T.MeshStandardMaterial({ name: 'env-car', vertexColors: true, roughness: 0.32, metalness: 0.45, envMapIntensity: 1.0 });
  M.redSteel = new T.MeshStandardMaterial({ name: 'env-bridge-red', color: '#b5432e', roughness: 0.6, metalness: 0.2 });
  M.concrete = new T.MeshStandardMaterial({ name: 'env-concrete', color: '#d9d6cf', roughness: 0.9 });
  M.lights = new T.PointsMaterial({ name: 'env-citylights', size: 2.2, sizeAttenuation: false, vertexColors: true, transparent: true,
    opacity: 0, depthWrite: false, toneMapped: false, fog: false });
  M.redLights = new T.PointsMaterial({ name: 'env-aviation', size: 3, sizeAttenuation: false, color: '#ff3a2a', transparent: true, opacity: 0,
    depthWrite: false, toneMapped: false, fog: false });
  for (const k in M) if (M[k].map && M[k] !== M.glow && M[k] !== M.pool) M[k].map.colorSpace = T.SRGBColorSpace;
}

// world-scaled horizontal quad (y may vary per corner)
function hquad(gb, x0, z0, x1, z1, y00, y10, y11, y01, s) {
  const U = (x, z) => [x / s, -z / s];
  gb.quad([x0, y00, z0], [x1, y10, z0], [x1, y11, z1], [x0, y01, z1], [U(x0, z0), U(x1, z0), U(x1, z1), U(x0, z1)], [0, 1, 0]);
}

// ---------------------------------------------------------------- the real neighbours (site photos)
function buildNeighbours(C, rng) {
  const g = C.near; // near-detail merged builders
  const Y = PAVE_Y, G = NEAR_Y;
  const pink = [0.9, 0.62, 0.53], white = [0.95, 0.94, 0.91], wall = [0.95, 0.945, 0.93];

  // --- WEST: pink 2-storey house no. 4, attached to the party wall at x = 0 (front set back ~3.6 m)
  {
    const x0 = -12.0, x1 = -0.02, z0 = -0.8, z1 = 14.6, base = Y + 0.15, top = base + 6.1; // OSM footprint
    g.facade.color(pink); facadeBox(g.facade, x0, z0, x1, z1, base, top, 0.4, 0.25);
    // eaves & tile roof (hipped, visible overhang as in the photo)
    g.plain.color([0.93, 0.9, 0.87]).box(x0 - 0.6, top - 0.2, z0 - 0.6, x1 + 0.02, top + 0.02, z1 + 0.6, 1, {});
    const rc = new T.Color('#b1553a'); g.roof.color(rc);
    hipRoof(g.roof, x0, z0, x1 - 0.3, z1, top, 0.42, 0.6);
    // first-floor balcony slab with wrought-iron loops railing (street side)
    g.plain.color(pink).box(-9.7, base + 3.0, z1, -0.6, base + 3.2, z1 + 1.2, 1, {});
    C.ironQuads.push({ x0: -9.7, x1: -0.6, z: z1 + 1.18, y0: base + 3.2, y1: base + 4.1 });
    C.ironQuads.push({ side: true, x: -9.7, z0: z1, z1: z1 + 1.18, y0: base + 3.2, y1: base + 4.1 });
    // ground floor: shutters/door recess darker
    g.plain.color([0.25, 0.18, 0.15]).box(-4.6, base, z1 - 0.01, -1.8, base + 2.3, z1 + 0.02, 1);
    // front wall with pink pillars + stone base, and gate no. 4
    const fz = 17.25;
    g.stone.box(-12.0, Y - 0.2, fz - 0.12, -3.2, Y + 0.55, fz + 0.12, 1.4);
    g.stone.box(-0.95, Y - 0.2, fz - 0.12, 0.0, Y + 0.55, fz + 0.12, 1.4);
    for (const px of [-12.0, -4.0, -3.2 - 0.6, -0.95]) g.plain.color(pink).box(px, Y - 0.2, fz - 0.2, px + 0.6, Y + 1.45, fz + 0.2, 1);
    g.plain.color([0.72, 0.62, 0.55]).box(-3.2, Y - 0.2, fz - 0.12, -1.2, Y + 0.2, fz + 0.12, 1); // gate threshold
    C.ironQuads.push({ x0: -3.15, x1: -0.98, z: fz, y0: Y + 0.2, y1: Y + 1.35 });   // gate
    C.ironQuads.push({ x0: -11.4, x1: -4.05, z: fz, y0: Y + 0.55, y1: Y + 1.25 });   // railing on wall
    // side walls of its front yard
    g.plain.color(wall).box(-12.0, Y - 0.2, z1, -11.8, Y + 1.3, fz, 1);
    // yard floor (tiles)
    g.plain.color([0.7, 0.66, 0.6]).box(-11.8, Y - 0.2, z1, -0.02, Y + 0.05, fz - 0.12, 1, { bottom: true });
  }

  // --- EAST: white 2-storey house with terracotta roof and round window (gable facing the street)
  {
    const x0 = 16.7, x1 = 27.7, z0 = 4.5, z1 = 13.0, base = Y + 0.6, top = base + 6.0; // OSM footprint
    g.facade.color(white); facadeBox(g.facade, x0, z0, x1, z1, base, top, 1.6, 0.5);
    const rc = new T.Color('#bf5a37'); g.roof.color(rc);
    gableRoof(g.roof, x0, z0, x1, z1, top, false, 0.5, 0.45);
    g.plain.color(white); gableEnds(g.plain, x0, z0, x1, z1, top, false, 0.5 * (x1 - x0 + 0.9) / (x1 - x0));
    // barge boards
    g.plain.color([0.97, 0.97, 0.96]).box(x0 - 0.45, top - 0.2, z1 + 0.35, x1 + 0.45, top, z1 + 0.5, 1, {});
    // round window in the gable (dark glass disc + white ring)
    C.roundWin = { x: (x0 + x1) / 2, y: top - 0.2 + 1.3, z: z1 + 0.02 };
    // brick pier at the right corner (as in the photo)
    const brick = [0.62, 0.3, 0.24];
    g.plain.color(brick).box(x1 - 0.9, base - 1.5, z1 - 0.9, x1, top, z1, 1);
    // ground floor windows + garage
    g.plain.color([0.28, 0.3, 0.33]).box(17.5, base + 0.3, z1 - 0.02, 19.9, base + 2.4, z1 + 0.01, 1);
    // front garden: white wall + green mesh fence on top, low planting
    const fz = 17.3;
    g.plain.color(wall).box(14.3, Y - 0.3, fz - 0.15, 30.8, Y + 1.25, fz + 0.1, 1);
    C.fenceQuads.push({ x0: 14.9, x1: 30.8, z: fz - 0.02, y0: Y + 1.25, y1: Y + 2.05 });
    g.yard.color([0.62, 0.64, 0.46]).box(14.45, G - 0.2, z1, 30.4, Y + 0.3, fz - 0.15, 6, { bottom: true });
    addTree(C, 19.2, 15.0, 0.85, 1); addTree(C, 25.5, 15.3, 0.7, 2);
  }

  // rear/side boundary walls, the houses behind and everything else come from OpenStreetMap (buildOSM)
}

// ---------------------------------------------------------------- street furniture: poles, cables, lamps
function buildStreetFurniture(C, rng) {
  const g = C.near;
  const zN = STREET.zKerb + 0.35, zS = ROW_Z + HALF - 0.35; // pole lines on both pavements
  const Y = PAVE_Y;
  // Rua Eduardo Couto: concrete utility poles on the south pavement, cables across to the houses (as in the photo)
  const poles = [];
  for (let x = SITE_ST.x0 + 2; x <= SITE_ST.x1; x += 26) poles.push([x + (rng() - 0.5) * 3, zS]);
  const lampPts = [];
  for (const [x, z] of poles) {
    const y0 = groundY(x, z) + PAVE_UP;
    // tapered concrete pole 9 m
    const pg = new T.CylinderGeometry(0.1, 0.16, 9, 8);
    g.plain.color([0.72, 0.71, 0.68]).geom(pg, new T.Matrix4().makeTranslation(x, y0 + 4.5, z));
    pg.dispose();
    // cross-arm
    g.plain.color([0.4, 0.4, 0.4]).box(x - 0.6, y0 + 8.4, z - 0.05, x + 0.6, y0 + 8.5, z + 0.05, 1, {});
    // lamp arm + head towards the road
    const ag = new T.CylinderGeometry(0.035, 0.035, 1.6, 6);
    g.metal.color([0.5, 0.5, 0.5]).geom(ag, new T.Matrix4().makeRotationX(Math.PI / 2 - 0.15).setPosition(x, y0 + 7.1, z - 0.8));
    ag.dispose();
    lampPts.push([x, y0 + 6.95, z - 1.55]);
  }
  // lamps on the north pavement too (wall-mounted on the houses side), offset
  for (let x = SITE_ST.x0 + 15; x <= SITE_ST.x1; x += 26) {
    if (x > -4 && x < 18) continue; // not in front of the lot
    const z = zN; const y0 = groundY(x, z) + PAVE_UP;
    const pg = new T.CylinderGeometry(0.06, 0.09, 6.2, 8);
    g.metal.color([0.28, 0.3, 0.31]).geom(pg, new T.Matrix4().makeTranslation(x, y0 + 3.1, z));
    pg.dispose();
    lampPts.push([x, y0 + 6.1, z + 0.45]);
    const ag = new T.CylinderGeometry(0.03, 0.03, 0.9, 6);
    g.metal.color([0.28, 0.3, 0.31]).geom(ag, new T.Matrix4().makeRotationX(Math.PI / 2).setPosition(x, y0 + 6.2, z + 0.25));
    ag.dispose();
  }
  // lamp heads (instanced) + glow sprites + light pools on the ground
  const headG = new T.CylinderGeometry(0.22, 0.32, 0.18, 10);
  const heads = new T.InstancedMesh(headG, C.mats.lampHead, lampPts.length);
  heads.name = 'env-streetlamp-heads';
  const m4 = new T.Matrix4();
  lampPts.forEach(([x, y, z], i) => heads.setMatrixAt(i, m4.makeTranslation(x, y, z)));
  C.group.add(heads);
  // glows & pools merged
  const glowGB = new GB(), poolGB = new GB();
  for (const [x, y, z] of lampPts) {
    const s = 1.2;
    // camera-facing is not needed for small halos: cross of 3 quads
    for (const a of [0, Math.PI / 3, 2 * Math.PI / 3]) {
      const dx = Math.cos(a) * s, dz = Math.sin(a) * s;
      glowGB.quad([x - dx, y - s - 0.1, z - dz], [x + dx, y - s - 0.1, z + dz], [x + dx, y + s - 0.1, z + dz], [x - dx, y + s - 0.1, z - dz]);
    }
    const r = 7, yg = groundY(x, z) + ROAD_UP + 0.02;
    poolGB.quad([x - r, yg, z + r], [x + r, yg, z + r], [x + r, yg, z - r], [x - r, yg, z - r], [[0, 0], [1, 0], [1, 1], [0, 1]]);
  }
  const glow = new T.Mesh(glowGB.build(), C.mats.glow); glow.name = 'env-streetlamp-halos'; glow.renderOrder = 5;
  const pool = new T.Mesh(poolGB.build(), C.mats.pool); pool.name = 'env-streetlamp-pools'; pool.renderOrder = 4;
  C.group.add(glow, pool);
  C.lampPts = lampPts;

  // Overhead cables: sagging catenaries between poles + drops across the street to façades
  const pts = [];
  const cable = (a, b, sag) => {
    const n = 14;
    for (let i = 0; i < n; i++) {
      const t0 = i / n, t1 = (i + 1) / n;
      const P = (t) => [lerp(a[0], b[0], t), lerp(a[1], b[1], t) - sag * 4 * t * (1 - t), lerp(a[2], b[2], t)];
      pts.push(...P(t0), ...P(t1));
    }
  };
  for (let i = 0; i < poles.length - 1; i++) {
    const [xa, za] = poles[i], [xb, zb] = poles[i + 1];
    const ya = groundY(xa, za) + PAVE_UP, yb = groundY(xb, zb) + PAVE_UP;
    for (const [dx, dy, sag] of [[-0.5, 8.45, 0.55], [0.5, 8.45, 0.6], [0, 7.6, 0.8]]) cable([xa + dx, ya + dy, za], [xb + dx, yb + dy, zb], sag);
  }
  // service drops to the houses on the north side (pink house) and the diagonal across the lot (photo)
  const p0 = poles.find(p => p[0] > -20) || poles[0];
  const yP = groundY(p0[0], p0[1]) + PAVE_UP;
  cable([p0[0], yP + 8.3, p0[1]], [-2.0, PAVE_Y + 6.0, 14.62], 0.5);
  cable([p0[0], yP + 8.3, p0[1]], [-4.0, PAVE_Y + 5.8, 14.62], 0.55);
  for (let i = 1; i < poles.length; i += 2) {
    const [x, z] = poles[i]; const y = groundY(x, z) + PAVE_UP;
    if (x > -3 && x < 17) continue;
    if (x < -12 || x > 28) cable([x, y + 8.2, z], [x + 3, PAVE_Y + 5.6, x < 0 ? 14.62 : 13.02], 0.4);
    cable([x, y + 8.2, z], [x - 2, PAVE_Y + 6.2, SITE_ST.paveS[1] + 0.05], 0.3);
  }
  const lg = new T.BufferGeometry();
  lg.setAttribute('position', new T.Float32BufferAttribute(pts, 3));
  const lines = new T.LineSegments(lg, C.mats.cable);
  lines.name = 'env-overhead-cables';
  C.group.add(lines);
}

// ---------------------------------------------------------------- trees & cars (instanced)
function treeGeometries() {
  // kind 0: round broadleaf (plane / lime), kind 1: cypress / pine-like column, kind 2: umbrella pine
  const mk = (parts) => {
    const gb = new GB();
    for (const [geo, m, col] of parts) { gb.color(col); gb.geom(geo, m); geo.dispose(); }
    return gb.build();
  };
  const trunk = [0.36, 0.28, 0.2];
  const g0 = mk([
    [new T.CylinderGeometry(0.12, 0.2, 3.2, 5, 1, true), new T.Matrix4().makeTranslation(0, 1.6, 0), trunk],
    [new T.IcosahedronGeometry(2.4, 1), new T.Matrix4().makeScale(1, 0.85, 1).setPosition(0, 4.6, 0), [0.33, 0.42, 0.22]],
    [new T.IcosahedronGeometry(1.6, 0), new T.Matrix4().makeTranslation(1.2, 5.5, 0.6), [0.38, 0.47, 0.25]],
    [new T.IcosahedronGeometry(1.5, 0), new T.Matrix4().makeTranslation(-1.1, 5.2, -0.7), [0.3, 0.39, 0.2]]
  ]);
  const g1 = mk([
    [new T.CylinderGeometry(0.1, 0.14, 1.2, 4, 1, true), new T.Matrix4().makeTranslation(0, 0.6, 0), trunk],
    [new T.ConeGeometry(1.1, 7, 7), new T.Matrix4().makeTranslation(0, 4.3, 0), [0.2, 0.3, 0.17]]
  ]);
  const g2 = mk([
    [new T.CylinderGeometry(0.16, 0.26, 7, 5, 1, true), new T.Matrix4().makeRotationZ(0.1).setPosition(0.3, 3.5, 0), trunk],
    [new T.IcosahedronGeometry(3, 1), new T.Matrix4().makeScale(1.3, 0.45, 1.2).setPosition(0.6, 7.6, 0), [0.25, 0.35, 0.2]]
  ]);
  return [g0, g1, g2];
}

function buildTrees(C) {
  const geos = treeGeometries();
  const byKind = [[], [], []];
  for (const t of C.trees || []) byKind[t.kind].push(t);
  const m4 = new T.Matrix4(), q = new T.Quaternion(), e = new T.Euler(), v = new T.Vector3(), sc = new T.Vector3();
  const rng = rngFrom(4242);
  byKind.forEach((list, k) => {
    if (!list.length) { geos[k].dispose(); return; }
    const im = new T.InstancedMesh(geos[k], C.mats.tree, list.length);
    im.name = `env-trees-${k}`;
    const col = new T.Color();
    list.forEach((t, i) => {
      e.set(0, rng() * Math.PI * 2, 0); q.setFromEuler(e);
      const s = t.s * (0.85 + rng() * 0.3);
      im.setMatrixAt(i, m4.compose(v.set(t.x, t.y - 0.1, t.z), q, sc.set(s, s * (0.9 + rng() * 0.2), s)));
      const k2 = 0.85 + rng() * 0.3; im.setColorAt(i, col.setRGB(k2, k2 * (0.95 + rng() * 0.1), k2 * 0.9));
    });
    im.castShadow = true; im.receiveShadow = true;
    im.computeBoundingSphere();
    C.group.add(im);
  });
}

function carGeometry() {
  const gb = new GB();
  const body = [1, 1, 1], glass = [0.08, 0.1, 0.12], tyre = [0.07, 0.07, 0.07], chrome = [0.75, 0.75, 0.75];
  // lower body (rounded-ish by stacking), cabin, windows, wheels, lights
  gb.color(body).rbox(0, 0, 4.2, 1.75, 0.3, 0.95, 0);
  gb.color(body).rbox(0, 0, 4.0, 1.7, 0.95, 1.0, 0);
  // trapezoid cabin as a lofted box (hatchback)
  const cabinShape = (w, y0, y1, xf0, xb0, xf1, xb1) => {
    const hw = w / 2, v = (x, y, z) => [x, y, z];
    const A = v(xb0, y0, -hw), B = v(xf0, y0, -hw), Cc = v(xf1, y1, -hw * 0.9), D = v(xb1, y1, -hw * 0.9);
    const E = v(xb0, y0, hw), F = v(xf0, y0, hw), G = v(xf1, y1, hw * 0.9), H = v(xb1, y1, hw * 0.9);
    return { A, B, C: Cc, D, E, F, G, H };
  };
  const c = cabinShape(1.6, 1.0, 1.45, 1.05, -1.75, 0.2, -1.45);
  gb.color(glass);
  gb.quad(c.B, c.F, c.G, c.C, null, [1, 0.5, 0]);   // windscreen
  gb.quad(c.E, c.A, c.D, c.H, null, [-1, 0.3, 0]);  // rear window
  gb.quad(c.A, c.B, c.C, c.D, null, [0, 0, -1]);    // side windows
  gb.quad(c.F, c.E, c.H, c.G, null, [0, 0, 1]);
  gb.color(body);
  gb.quad(c.D, c.C, c.G, c.H, null, [0, 1, 0]);     // roof
  // wheels
  const wg = new T.CylinderGeometry(0.31, 0.31, 0.22, 8).rotateX(Math.PI / 2);
  for (const [x, z] of [[1.3, 0.78], [-1.3, 0.78], [1.3, -0.78], [-1.3, -0.78]]) gb.color(tyre).geom(wg, new T.Matrix4().makeTranslation(x, 0.31, z));
  wg.dispose();
  // lights
  gb.color([1, 0.95, 0.85]).rbox(2.1, 0.55, 0.04, 0.3, 0.72, 0.82, 0);
  gb.color([1, 0.95, 0.85]).rbox(2.1, -0.55, 0.04, 0.3, 0.72, 0.82, 0);
  gb.color([0.6, 0.05, 0.05]).rbox(-2.1, 0.6, 0.04, 0.25, 0.78, 0.9, 0);
  gb.color([0.6, 0.05, 0.05]).rbox(-2.1, -0.6, 0.04, 0.25, 0.78, 0.9, 0);
  gb.color(chrome).rbox(2.12, 0, 0.04, 0.8, 0.42, 0.55, 0);
  return gb.build();
}
const CAR_COLS = ['#1d1f22', '#f0f0ee', '#9ea3a8', '#2d3a4f', '#6e7378', '#7a1e1e', '#e9e5da', '#3b4b3a', '#b8bcc0', '#101216'];

function buildCars(C) {
  const list = C.cars;
  if (!list.length) return;
  const geo = carGeometry();
  const im = new T.InstancedMesh(geo, C.mats.car, list.length);
  im.name = 'env-parked-cars';
  const m4 = new T.Matrix4(), q = new T.Quaternion(), v = new T.Vector3(), s = new T.Vector3(1, 1, 1), col = new T.Color();
  list.forEach((c, i) => {
    q.setFromAxisAngle(new T.Vector3(0, 1, 0), c.ry + (c.col - 0.5) * 0.04);
    const y = c.y !== undefined ? c.y : groundY(c.x, c.z) + ROAD_UP;
    im.setMatrixAt(i, m4.compose(v.set(c.x, y, c.z), q, s));
    col.set(CAR_COLS[Math.floor(c.col * 997) % CAR_COLS.length]);
    im.setColorAt(i, col);
  });
  im.castShadow = true; im.receiveShadow = true;
  im.computeBoundingSphere();
  C.group.add(im);
}

// wrought-iron and fence quads (alpha-tested)
function buildAlphaQuads(C) {
  const iron = new GB(), fence = new GB();
  for (const q of C.ironQuads) {
    if (q.side) iron.quad([q.x, q.y0, q.z0], [q.x, q.y0, q.z1], [q.x, q.y1, q.z1], [q.x, q.y1, q.z0], [[0, 0], [(q.z1 - q.z0) / 1.6, 0], [(q.z1 - q.z0) / 1.6, 1], [0, 1]]);
    else iron.quad([q.x0, q.y0, q.z], [q.x1, q.y0, q.z], [q.x1, q.y1, q.z], [q.x0, q.y1, q.z], [[0, 0], [(q.x1 - q.x0) / 1.6, 0], [(q.x1 - q.x0) / 1.6, 1], [0, 1]]);
  }
  for (const q of C.fenceQuads) {
    if (q.a) { // free segment {a:[x,y,z], b, h}
      const L = Math.hypot(q.b[0] - q.a[0], q.b[2] - q.a[2]) / 1.2, V = q.h / 1.2;
      fence.quad(q.a, q.b, [q.b[0], q.b[1] + q.h, q.b[2]], [q.a[0], q.a[1] + q.h, q.a[2]], [[0, 0], [L, 0], [L, V], [0, V]]);
    } else fence.quad([q.x0, q.y0, q.z], [q.x1, q.y0, q.z], [q.x1, q.y1, q.z], [q.x0, q.y1, q.z], [[0, 0], [(q.x1 - q.x0) / 1.2, 0], [(q.x1 - q.x0) / 1.2, (q.y1 - q.y0) / 1.2], [0, (q.y1 - q.y0) / 1.2]]);
  }
  if (!iron.empty) { const m = new T.Mesh(iron.build(), C.mats.iron); m.name = 'env-wrought-iron'; m.castShadow = true; C.group.add(m); }
  if (!fence.empty) { const m = new T.Mesh(fence.build(), C.mats.fence); m.name = 'env-green-fence'; C.group.add(m); }
  if (C.roundWin) {
    const { x, y, z } = C.roundWin;
    const ring = new T.Mesh(new T.TorusGeometry(0.42, 0.07, 8, 24), C.mats.plain);
    ring.geometry.setAttribute('color', new T.Float32BufferAttribute(new Array(ring.geometry.attributes.position.count * 3).fill(0.97), 3));
    ring.position.set(x, y, z + 0.04); ring.name = 'env-round-window-frame';
    const disc = new T.Mesh(new T.CircleGeometry(0.42, 24), C.mats.glassDark);
    disc.position.set(x, y, z + 0.02); disc.name = 'env-round-window';
    C.group.add(ring, disc);
  }
}

// ---------------------------------------------------------------- far shore: Lisbon, Barreiro, Seixal, Montijo
// Far scenery is authored in the phase-1 "old" frame (x = east, z = south) and lives in C.far, a group whose transform
// maps that frame onto the local one exactly (FAR_XFORM). Heights always come from the local terrain.
function oldXZ(lat, lon) { return [7 + (lon - LON0) * M_LON, 7 - (lat - LAT0) * M_LAT]; }
function lm(id) { const l = LANDMARKS.find(o => o.id === id); return l ? oldXZ(l.lat, l.lon) : null; }
function farH(xo, zo) { const [x, z] = oldToLocal(xo, zo); return heightAt(x, z); }

function buildFarCity(C, rng, low) {
  const gb = new GB();     // old frame (C.far)
  const lgb = new GB();    // local frame: filler towns beyond the OSM coverage
  const lightPos = [], lightCol = [], lLightPos = [], lLightCol = [];
  const addLights = (P, Cc, x0, z0, x1, z1, y0, y1, n) => {
    for (let i = 0; i < n; i++) {
      P.push(lerp(x0, x1, rng()), lerp(y0, y1, rng()), lerp(z0, z1, rng()));
      const w = rng();
      if (w < 0.6) Cc.push(1.0, 0.72, 0.4); else if (w < 0.85) Cc.push(1.0, 0.85, 0.62); else Cc.push(0.8, 0.88, 1.0);
    }
  };
  const block = (x, z, w, d, h, col, lights = true) => {
    const [lx, lz] = oldToLocal(x, z);
    if (C.covered(lx, lz)) return;
    const b = farH(x, z);
    if (b <= WATER_Y + 0.5) return;
    gb.color(col);
    facadeBox(gb, x - w / 2, z - d / 2, x + w / 2, z + d / 2, b, b + h, 6, (rng() * 4 | 0) / 4);
    gb.plain(true).box(x - w / 2, b + h, z - d / 2, x + w / 2, b + h + 0.1, z + d / 2, 1, {}).plain(false);
    if (lights) addLights(lightPos, lightCol, x - w / 2, z + d / 2 + 1, x + w / 2, z + d / 2 + 1, b + 2, b + h - 1, Math.ceil(w * h / 90));
  };
  const cityCols = ['#ece6da', '#f2efe8', '#e6d6c0', '#ddd8cf', '#f0e2cf', '#d9cbb8', '#efe9e0', '#cfd3d6'];
  const col = () => new T.Color(cityCols[rng() * cityCols.length | 0]);
  // Lisbon: fill the north bank polygon near the shore (layers get taller inland)
  for (let i = 0; i < (low ? 1400 : 2600); i++) {
    const x = lerp(-17500, -2500, rng()), z = lerp(-17000, -2800, rng());
    const sd = polySD(LISBON_POLY, x, z);
    if (sd < 40 || sd > 3200) continue;
    const toBaixa = Math.hypot(x + 9150, z + 4350);
    const tall = rng() < 0.08 + (x > -8500 ? 0.1 : 0);
    const h = tall ? 30 + rng() * 60 : 9 + rng() * 14;
    block(x, z, 25 + rng() * 55, 20 + rng() * 40, toBaixa < 900 ? Math.min(h, 22) : h, col());
  }
  const pn = lm('parque-nacoes');
  if (pn) {
    for (let i = 0; i < 40; i++) block(pn[0] + (rng() - 0.5) * 1400, pn[1] + (rng() - 0.3) * 1400, 30 + rng() * 30, 25 + rng() * 25, 25 + rng() * 45, col());
    block(pn[0] - 300, pn[1] + 200, 22, 22, 145, [0.9, 0.92, 0.94]);       // Vasco da Gama tower (approx.)
  }
  for (const [x, z, h] of [[-11200, -7300, 90], [-11050, -7250, 85], [-10300, -7400, 75], [-9400, -9800, 100], [-9700, -10200, 110], [-8600, -11200, 80], [-7700, -10800, 95], [-8200, -8800, 70]]) block(x, z, 30, 30, h, col());
  // Almada / Seixal / Montijo (far south bank), low
  for (let i = 0; i < (low ? 500 : 1000); i++) {
    const x = lerp(-12000, 14000, rng()), z = lerp(-12000, 4000, rng());
    const [lx, lz] = oldToLocal(x, z);
    if (Math.hypot(lx - 7, lz - 7) < 4200 || polySD(LISBON_POLY, x, z) > -200) continue;
    block(x, z, 20 + rng() * 30, 14 + rng() * 20, 7 + rng() * 10, col(), rng() < 0.7);
  }
  // Local filler: Barreiro / Baixa da Banheira / Moita beyond the OSM extract (terraces, oriented per 250 m cell)
  const roofC = () => new T.Color(ROOF_COLS[rng() * ROOF_COLS.length | 0]);
  const n = low ? 2500 : 5000;
  for (let i = 0; i < n; i++) {
    const a = rng() * Math.PI * 2, r = Math.sqrt(lerp(700 * 700, 4200 * 4200, rng()));
    const x = 7 + Math.cos(a) * r, z = 7 + Math.sin(a) * r;
    if (C.covered(x, z) || landFrac(x, z) < 0.99) continue;
    const blk = rng() < 0.3;
    const w = blk ? 24 + rng() * 22 : 10 + rng() * 20, d = blk ? 11.5 : 9 + rng() * 3;
    const ang = hash(Math.floor(x / 250) * 7919 + Math.floor(z / 250)) * Math.PI;
    const ca = Math.cos(ang), sa = Math.sin(ang);
    const P = [[-w / 2, -d / 2], [w / 2, -d / 2], [w / 2, d / 2], [-w / 2, d / 2]].map(([u, v]) => [x + u * ca - v * sa, z + u * sa + v * ca]);
    if (P.some(([px, pz]) => landFrac(px, pz) < 0.99 || C.covered(px, pz))) continue;
    const b = Math.min(...P.map(([px, pz]) => groundY(px, pz)));
    const h = blk ? (rng() < 0.3 ? 15 : 12) : (rng() < 0.25 ? 3.3 : 6.3);
    const start = lgb.p.length;
    lgb.color(blk ? col() : new T.Color(HOUSE_COLS[rng() * HOUSE_COLS.length | 0]));
    facadeBox(lgb, -w / 2, -d / 2, w / 2, d / 2, 0, h, 2.5, (rng() * 4 | 0) / 4);
    lgb.plain(true).color(roofC());
    hipRoof(lgb, -w / 2, -d / 2, w / 2, d / 2, h, blk ? 0.3 : 0.42, 0.3);
    lgb.plain(false);
    lgb.xform(start, new T.Matrix4().makeRotationY(-ang).setPosition(x, b, z));
    if (rng() < 0.5) addLights(lLightPos, lLightCol, x - 3, z - 3, x + 3, z + 3, b + 1.5, b + h - 1, blk ? 5 : 2);
  }
  const mesh = new T.Mesh(gb.build(), C.mats.city);
  mesh.name = 'env-far-city';
  C.far.add(mesh);
  const lmesh = new T.Mesh(lgb.build(), C.mats.city);
  lmesh.name = 'env-mid-towns';
  C.group.add(lmesh);
  for (const [P, Cc, parent, name] of [[lightPos, lightCol, C.far, 'env-city-lights'], [lLightPos, lLightCol, C.group, 'env-town-lights']]) {
    const lg = new T.BufferGeometry();
    lg.setAttribute('position', new T.Float32BufferAttribute(P, 3));
    lg.setAttribute('color', new T.Float32BufferAttribute(Cc, 3));
    const pts = new T.Points(lg, C.mats.lights);
    pts.name = name; pts.frustumCulled = false;
    parent.add(pts);
  }
}

function buildBridges(C) {
  const redGB = new GB(), conGB = new GB();
  const cablePts = [], stayPts = [];
  const catenary = (a, b, sag, n = 24) => {
    for (let i = 0; i < n; i++) {
      const P = (t) => [lerp(a[0], b[0], t), lerp(a[1], b[1], t) - sag * 4 * t * (1 - t), lerp(a[2], b[2], t)];
      cablePts.push(...P(i / n), ...P((i + 1) / n));
    }
  };
  // --- 25 de Abril: main span 1013 m, towers 190 m, deck 70 m above water, roughly N–S (az ~ 20°)
  const p25 = lm('ponte-25');
  if (p25) {
    const [cx, cz] = p25;
    const ang = -17 * DEG; const dir = [Math.sin(ang), -Math.cos(ang)]; // unit vector towards the north bank (Alcântara, NNW)
    const at = (s, off = 0) => [cx + dir[0] * s - dir[1] * off, cz + dir[1] * s + dir[0] * off];
    const W = WATER_Y;
    const deckY = W + 70, towerH = 190;
    // towers at ±506 m
    for (const s of [-506, 506]) {
      for (const o of [-12, 12]) {
        const [x, z] = at(s, o);
        redGB.rbox(x, z, 7, 7, W - 2, W + towerH, -ang);
      }
      for (const h of [deckY + 5, W + towerH - 50, W + towerH - 3]) { const [x, z] = at(s, 0); redGB.rbox(x, z, 28, 5, h, h + 5, -ang); }
    }
    // deck truss (as a red box) from south anchorage to north
    const s0 = -1500, s1 = 1300;
    const n = 28;
    for (let i = 0; i < n; i++) {
      const sa = lerp(s0, s1, i / n), sb = lerp(s0, s1, (i + 1) / n), sm = (sa + sb) / 2;
      const [x, z] = at(sm, 0);
      const y = sm < -506 ? lerp(deckY - 18, deckY, (sm - s0) / (-506 - s0)) : sm > 506 ? lerp(deckY, deckY - 10, (sm - 506) / (s1 - 506)) : deckY;
      redGB.rbox(x, z, 24, sb - sa + 1, y - 9, y, -ang);
      // approach viaduct piers
      if (sm < -560 || sm > 560) conGB.rbox(x, z, 16, 8, W - 2, y - 9, -ang);
    }
    // main cables
    for (const o of [-12, 12]) {
      const A = at(-1100, o), B = at(-506, o), Cc = at(506, o), D = at(1000, o);
      catenary([A[0], deckY - 5, A[1]], [B[0], W + towerH, B[1]], -30, 12);
      catenary([B[0], W + towerH, B[1]], [Cc[0], W + towerH, Cc[1]], 110, 40);
      catenary([Cc[0], W + towerH, Cc[1]], [D[0], deckY - 5, D[1]], -30, 12);
    }
  }
  // --- Cristo Rei: 82 m pedestal + 28 m statue on the Almada cliff
  const cr = lm('cristo-rei');
  if (cr) {
    const [x, z] = cr; const b = farH(x, z);
    conGB.rbox(x, z, 26, 26, b - 3, b + 20, 0);
    // pedestal: four legs portal
    conGB.rbox(x, z, 20, 20, b + 20, b + 75, 0);
    conGB.rbox(x, z, 26, 26, b + 75, b + 82, 0);
    conGB.rbox(x, z, 5, 5, b + 82, b + 104, 0);       // statue body
    conGB.rbox(x, z, 28, 3.5, b + 99, b + 103, 0.2); // arms spread
    conGB.rbox(x, z, 3, 3, b + 104, b + 108, 0);      // head
  }
  // --- Vasco da Gama: 12.3 km long, low viaduct (deck ~ 14 m), cable-stayed main span near the north bank
  const vg = lm('vasco-gama');
  if (vg) {
    const N = oldXZ(38.7785, -9.0885);      // Sacavém end (north bank)
    const S = oldXZ(38.7170, -8.9850);      // Samouco / Montijo end (south bank)
    const len = Math.hypot(S[0] - N[0], S[1] - N[1]);
    const ux = (S[0] - N[0]) / len, uz = (S[1] - N[1]) / len;
    const ang = Math.atan2(ux, uz);
    const W = WATER_Y;
    const segs = Math.ceil(len / 180);
    for (let i = 0; i < segs; i++) {
      const t0 = i / segs, t1 = (i + 1) / segs, tm = (t0 + t1) / 2;
      const x = lerp(N[0], S[0], tm), z = lerp(N[1], S[1], tm);
      const d = tm * len;
      const y = W + (d > 1200 && d < 2400 ? 45 : d < 1200 ? lerp(10, 45, d / 1200) : d < 3500 ? lerp(45, 14, (d - 2400) / 1100) : 14);
      conGB.rbox(x, z, 30, len / segs + 1, y - 2.2, y, ang);
      conGB.rbox(x, z, 8, 3, W - 2, y - 2.2, ang);
    }
    // two H pylons (150 m) near the north end with fan stays
    for (const d of [1400, 1820]) {
      const x = N[0] + ux * d, z = N[1] + uz * d;
      conGB.rbox(x, z, 34, 6, W - 2, W + 150, ang);
      for (let k = 1; k <= 6; k++) {
        for (const sgn of [-1, 1]) {
          const e = sgn * k * 35;
          stayPts.push(x, W + 150 - k * 6, z, x + ux * e, W + 45, z + uz * e);
        }
      }
    }
  }
  if (!redGB.empty) {
    const m = new T.Mesh(redGB.build(), C.mats.redSteel); m.name = 'env-ponte-25-abril'; C.far.add(m);
  }
  if (!conGB.empty) {
    const m = new T.Mesh(conGB.build(), C.mats.concrete); m.name = 'env-bridges-cristo-rei'; C.far.add(m);
  }
  const lg = new T.BufferGeometry(); lg.setAttribute('position', new T.Float32BufferAttribute(cablePts, 3));
  const lines = new T.LineSegments(lg, new T.LineBasicMaterial({ color: '#a8432f', transparent: true, opacity: 0.8 }));
  lines.name = 'env-bridge-cables'; C.far.add(lines);
  C.mats.bridgeCable = lines.material;
  const sg = new T.BufferGeometry(); sg.setAttribute('position', new T.Float32BufferAttribute(stayPts, 3));
  const stays = new T.LineSegments(sg, new T.LineBasicMaterial({ color: '#e8e8e4', transparent: true, opacity: 0.7 }));
  stays.name = 'env-vasco-da-gama-stays'; C.far.add(stays);
}

// ================================================================ REAL CONTEXT (OpenStreetMap + EU-DEM)
function addTree(C, x, z, scale = 1, kind = 0) {
  C.trees.push({ x, z, y: groundY(x, z), s: scale, kind });
}
function ringArea(P) { let a = 0; for (let i = 0, j = P.length - 1; i < P.length; j = i++) a += (P[j][0] + P[i][0]) * (P[j][1] - P[i][1]); return a / 2; }
function inPoly(P, x, z) {
  let inside = false;
  for (let i = 0, j = P.length - 1; i < P.length; j = i++) {
    const [xi, zi] = P[i], [xj, zj] = P[j];
    if ((zi > z) !== (zj > z) && x < (xj - xi) * (z - zi) / (zj - zi) + xi) inside = !inside;
  }
  return inside;
}
const inRect = (x, z, r) => x > r.x0 && x < r.x1 && z > r.z0 && z < r.z1;
const LOT_R = { x0: LOT.x0, x1: LOT.x1, z0: LOT.zRear, z1: LOT.zFront };
const SITE_BAND = { x0: SITE_ST.x0, x1: SITE_ST.x1, z0: SITE_ST.paveN[0], z1: SITE_ST.paveS[1] };
// hand-modelled neighbours (their OSM duplicates are dropped)
const WEST_R = { x0: -12.6, x1: 0.6, z0: -1.4, z1: 15.2 }, EAST_R = { x0: 16.1, x1: 28.3, z0: 3.9, z1: 13.6 };

// ---------------------------------------------------------------- terrain meshes (3 nested levels + skirts)
function terrainVertexColor(x, z, h, rnd, out) {
  let c;
  const lf = landFrac(x, z);
  if (lf < 0) {
    const [xo, zo] = localToOld(x, z);
    c = polySD(LISBON_POLY, xo, zo) > 0 ? [0.63, 0.61, 0.58] : (vnoise(xo * 2, zo * 2) > 0.2 ? [0.44, 0.47, 0.32] : [0.62, 0.57, 0.43]);
  } else {
    const r = Math.hypot(x - 7, z - 7), n = vnoise(x * 2.3, z * 2.3);
    if (r < 4300 && n > -0.35) c = [0.63, 0.6, 0.54];              // towns: pale paved / built-up ground
    else c = n > 0.3 ? [0.43, 0.47, 0.31] : [0.62, 0.56, 0.41];     // dry fields, pine woods
  }
  if (h < WATER_Y + 1.2) c = [0.6, 0.56, 0.47];                      // mudflats / shore
  const k = 0.94 + rnd * 0.1;
  out.setRGB(c[0] * k, c[1] * k, c[2] * k, T.SRGBColorSpace);
  return out;
}
function buildGridMesh({ half, cell, skip, name, colors, uvRect, skirtDepth = 0 }) {
  const n = Math.round(2 * half / cell), x0 = 7 - half, z0 = 7 - half, N1 = n + 1;
  const rng = rngFrom(n * 131 + cell);
  const H = new Float32Array(N1 * N1);
  for (let j = 0; j <= n; j++) for (let i = 0; i <= n; i++) H[j * N1 + i] = Math.max(WATER_Y + 0.02, heightAt(x0 + i * cell, z0 + j * cell));
  const pos = [], col = [], uv = [], idx = [], map = new Int32Array(N1 * N1).fill(-1);
  const tc = new T.Color();
  const vid = (i, j) => {
    const k = j * N1 + i;
    if (map[k] < 0) {
      const x = x0 + i * cell, z = z0 + j * cell, h = H[k];
      map[k] = pos.length / 3;
      pos.push(x, h, z);
      if (colors) { terrainVertexColor(x, z, h, rng(), tc); col.push(tc.r, tc.g, tc.b); } else col.push(1, 1, 1);
      if (uvRect) uv.push((x - uvRect.x0) / uvRect.w, 1 - (z - uvRect.z0) / uvRect.w); else uv.push(0, 0);
    }
    return map[k];
  };
  const wet = (h) => h < WATER_Y + 0.05;
  for (let j = 0; j < n; j++) for (let i = 0; i < n; i++) {
    const a0 = H[j * N1 + i], b0 = H[j * N1 + i + 1], c0 = H[(j + 1) * N1 + i], d0 = H[(j + 1) * N1 + i + 1];
    if (wet(a0) && wet(b0) && wet(c0) && wet(d0)) continue;
    if (skip && skip(x0 + i * cell, z0 + j * cell, x0 + (i + 1) * cell, z0 + (j + 1) * cell)) continue;
    const a = vid(i, j), b = vid(i + 1, j), c = vid(i, j + 1), d = vid(i + 1, j + 1);
    if (!(wet(a0) && wet(c0) && wet(b0))) idx.push(a, c, b);
    if (!(wet(b0) && wet(c0) && wet(d0))) idx.push(b, c, d);
  }
  // skirts along the outer border hide cracks against the next (coarser) level
  if (skirtDepth > 0) {
    const edge = (i0, j0, di, dj) => {
      for (let k = 0; k < n; k++) {
        const ia = i0 + di * k, ja = j0 + dj * k, ib = ia + di, jb = ja + dj;
        const ha = H[ja * N1 + ia], hb = H[jb * N1 + ib];
        if (wet(ha) && wet(hb)) continue;
        const a = vid(ia, ja), b = vid(ib, jb);
        const s = pos.length / 3;
        pos.push(pos[a * 3], ha - skirtDepth, pos[a * 3 + 2], pos[b * 3], hb - skirtDepth, pos[b * 3 + 2]);
        col.push(col[a * 3], col[a * 3 + 1], col[a * 3 + 2], col[b * 3], col[b * 3 + 1], col[b * 3 + 2]);
        uv.push(uv[a * 2], uv[a * 2 + 1], uv[b * 2], uv[b * 2 + 1]);
        idx.push(a, b, s, b, s + 1, s, a, s, b, b, s, s + 1); // both windings
      }
    };
    edge(0, 0, 1, 0); edge(0, n, 1, 0); edge(0, 0, 0, 1); edge(n, 0, 0, 1);
  }
  const g = new T.BufferGeometry();
  g.setAttribute('position', new T.Float32BufferAttribute(pos, 3));
  g.setAttribute('color', new T.Float32BufferAttribute(col, 3));
  g.setAttribute('uv', new T.Float32BufferAttribute(uv, 2));
  g.setIndex(idx);
  g.computeVertexNormals();
  g.computeBoundingSphere();
  const m = new T.Mesh(g, null);
  m.name = name;
  return m;
}
const PAINT = { x0: 7 - INNER.r, z0: 7 - INNER.r, w: 2 * INNER.r };
function buildTerrain(C, low) {
  const out = new T.Group(); out.name = 'env-terrain';
  const inner = buildGridMesh({ half: INNER.r, cell: low ? 2 * INNER.c : INNER.c, name: 'env-terrain-inner', colors: false, uvRect: PAINT, skirtDepth: 8,
    skip: (x0, z0, x1, z1) => x0 >= NEARG.x0 - 0.01 && x1 <= NEARG.x1 + 0.01 && z0 >= NEARG.z0 - 0.01 && z1 <= NEARG.z1 + 0.01 });
  inner.material = C.mats.terrainInner; inner.receiveShadow = true;
  const mid = buildGridMesh({ half: MID.r, cell: low ? 2 * MID.c : MID.c, name: 'env-terrain-mid', colors: true, skirtDepth: 20,
    skip: (x0, z0, x1, z1) => x0 >= 7 - INNER.r - 0.01 && x1 <= 7 + INNER.r + 0.01 && z0 >= 7 - INNER.r - 0.01 && z1 <= 7 + INNER.r + 0.01 });
  mid.material = C.mats.terrain;
  const far = buildGridMesh({ half: OUTER.r, cell: OUTER.c, name: 'env-terrain-far', colors: true,
    skip: (x0, z0, x1, z1) => x0 >= 7 - MID.r - 0.01 && x1 <= 7 + MID.r + 0.01 && z0 >= 7 - MID.r - 0.01 && z1 <= 7 + MID.r + 0.01 });
  far.material = C.mats.terrain;
  out.add(inner, mid, far);
  return out;
}

// ---------------------------------------------------------------- ground paint (landuse, parks, parking, footprint AO) — 1024 px over 2.5 km
const LU_COL = {
  grass: '#93a063', park: '#86a05a', garden: '#8aa35c', recreation_ground: '#8ea45e', pitch: '#6f9a4f', playground: '#b9a98a',
  sports_centre: '#a9a595', water_park: '#9fb7c2', wetland: '#7f8a62', sand: '#ddd0ad', beach: '#e2d5b0', brownfield: '#b8a98c',
  construction: '#b9ab91', greenfield: '#a4a56a', industrial: '#bcb7ad', railway: '#aaa197', retail: '#c4bfb5', cemetery: '#a6a58c',
  allotments: '#9aa062', farmyard: '#b3a57f', residential: null, parking: '#a2a19c', school: '#cfc4ad'
};
function paintGround(osm, rng) {
  const S = 1024, k = S / PAINT.w;
  const X = (x) => (x - PAINT.x0) * k, Z = (z) => (z - PAINT.z0) * k;
  return canvasTex(S, (g) => {
    g.fillStyle = '#cbc3b1'; g.fillRect(0, 0, S, S);
    for (let i = 0; i < 26000; i++) { // mottled dry ground
      const v = rng();
      g.fillStyle = v < 0.4 ? 'rgba(150,140,110,0.22)' : v < 0.7 ? 'rgba(215,208,190,0.25)' : 'rgba(135,140,95,0.18)';
      g.fillRect(rng() * S, rng() * S, 1 + rng() * 5, 1 + rng() * 5);
    }
    const poly = (p, fill, stroke) => {
      g.beginPath();
      p.forEach(([x, z], i) => i ? g.lineTo(X(x), Z(z)) : g.moveTo(X(x), Z(z)));
      g.closePath();
      if (fill) { g.fillStyle = fill; g.fill(); }
      if (stroke) { g.strokeStyle = stroke; g.lineWidth = 1; g.stroke(); }
    };
    for (const l of [...(osm.lu || []), ...(osm.g || []), ...(osm.am || [])]) {
      const c = LU_COL[l.k];
      if (!c || !l.p || l.p.length < 3) continue;
      poly(l.p, c, l.k === 'pitch' ? 'rgba(255,255,255,0.7)' : null);
    }
    // soft ambient-occlusion halo around building footprints
    try { g.filter = 'blur(1.5px)'; } catch (e) { /* ignore */ }
    for (const b of osm.b || []) if (b.p && b.p.length > 3) poly(b.p, 'rgba(70,64,56,0.55)');
    try { g.filter = 'none'; } catch (e) { /* ignore */ }
    // tree shade blotches
    g.fillStyle = 'rgba(60,70,40,0.35)';
    for (const [x, z] of osm.t || []) { g.beginPath(); g.arc(X(x), Z(z), 2.2 * k * 1.3, 0, Math.PI * 2); g.fill(); }
  }, { repeat: false, aniso: 8 });
}

// ---------------------------------------------------------------- the site: flat ground around the lot + Rua Eduardo Couto
function buildSiteGround(C, osm) {
  const g = C.near.ground;
  const Y = NEAR_Y;
  const rect = (x0, z0, x1, z1) => {
    const U = (x, z) => [(x - PAINT.x0) / PAINT.w, 1 - (z - PAINT.z0) / PAINT.w];
    g.quad([x0, Y, z0], [x1, Y, z0], [x1, Y, z1], [x0, Y, z1], [U(x0, z0), U(x1, z0), U(x1, z1), U(x0, z1)], [0, 1, 0]);
  };
  const N = NEARG, L = LOT_R, B = SITE_BAND;
  rect(N.x0, N.z0, N.x1, L.z0);
  rect(N.x0, L.z0, L.x0, B.z0); rect(L.x1, L.z0, N.x1, B.z0);
  rect(N.x0, B.z0, B.x0, B.z1); rect(B.x1, B.z0, N.x1, B.z1);
  rect(N.x0, B.z1, N.x1, N.z1);
  // soil under the lot + earth skirts (only visible if the building leaves gaps)
  const soil = C.near.plain.color([0.42, 0.37, 0.3]);
  const yT = NEAR_Y, yB = -3.4;
  soil.quad([L.x0, yB, L.z0], [L.x1, yB, L.z0], [L.x1, yB, L.z1], [L.x0, yB, L.z1], null, [0, 1, 0]);
  soil.quad([L.x0, yB, L.z0], [L.x1, yB, L.z0], [L.x1, yT, L.z0], [L.x0, yT, L.z0], null, [0, 0, 1]);
  soil.quad([L.x0, yB, L.z1], [L.x0, yB, L.z0], [L.x0, yT, L.z0], [L.x0, yT, L.z1], null, [1, 0, 0]);
  soil.quad([L.x1, yB, L.z0], [L.x1, yB, L.z1], [L.x1, yT, L.z1], [L.x1, yT, L.z0], null, [-1, 0, 0]);
  soil.quad([L.x1, yB, L.z1], [L.x0, yB, L.z1], [L.x0, PAVE_Y, L.z1], [L.x1, PAVE_Y, L.z1], null, [0, 0, -1]);

  // Rua Eduardo Couto: asphalt, two calçada pavements with 10 cm limestone kerbs, gaps where side streets join
  const road = C.near.asphalt, pave = C.near.calcada;
  const yR = TERR_FLAT + ROAD_UP, yP = PAVE_Y;
  const hq = (gb, x0, z0, x1, z1, y, s) => gb.quad([x0, y, z0], [x1, y, z0], [x1, y, z1], [x0, y, z1], [[x0 / s, -z0 / s], [x1 / s, -z0 / s], [x1 / s, -z1 / s], [x0 / s, -z1 / s]], [0, 1, 0]);
  hq(road, B.x0, SITE_ST.paveN[1], B.x1, SITE_ST.paveS[0], yR, 8);
  // side streets crossing the pavement lines
  const gaps = { n: [], s: [] };
  for (const r of osm.r || []) {
    if (!ROAD_W[r.k] || ROAD_W[r.k].foot) continue;
    const w = (r.w || ROAD_W[r.k].w) / 2 + 1.2;
    for (let i = 0; i < r.p.length - 1; i++) {
      const [ax, az] = r.p[i], [bx, bz] = r.p[i + 1];
      for (const [key, zl] of [['n', SITE_ST.paveN[0] + 0.1], ['s', SITE_ST.paveS[1] - 0.1]]) {
        if ((az - zl) * (bz - zl) >= 0 || Math.abs(bz - az) < 3) continue; // only roads crossing across the band
        const x = ax + (bx - ax) * (zl - az) / (bz - az);
        if (x > B.x0 && x < B.x1) gaps[key].push([x - w, x + w]);
      }
    }
  }
  const pavement = (z0, z1, kerbZ, kerbOut, list) => {
    const cuts = list.slice().sort((a, b) => a[0] - b[0]);
    let x = B.x0;
    const seg = (xa, xb) => {
      if (xb - xa < 0.3) return;
      hq(pave, xa, z0, xb, z1, yP, 1.6);
      pave.quad([xa, yR, kerbZ], [xb, yR, kerbZ], [xb, yP, kerbZ], [xa, yP, kerbZ], [[0, 0], [1, 0], [1, 0.08], [0, 0.08]], [0, 0, kerbOut]);
      for (const xe of [xa, xb]) pave.quad([xe, yR, z0], [xe, yR, z1], [xe, yP, z1], [xe, yP, z0], [[0, 0], [1, 0], [1, 0.08], [0, 0.08]], [xe === xa ? -1 : 1, 0, 0]);
    };
    for (const [a, b] of cuts) { seg(x, Math.max(x, a)); x = Math.max(x, b); }
    seg(x, B.x1);
  };
  pavement(SITE_ST.paveN[0], SITE_ST.paveN[1], SITE_ST.paveN[1], 1, gaps.n);
  pavement(SITE_ST.paveS[0], SITE_ST.paveS[1], SITE_ST.paveS[0], -1, gaps.s);
  // fill under the gaps with asphalt
  for (const [a, b] of gaps.n) hq(road, Math.max(B.x0, a), SITE_ST.paveN[0], Math.min(B.x1, b), SITE_ST.paveN[1], yR, 8);
  for (const [a, b] of gaps.s) hq(road, Math.max(B.x0, a), SITE_ST.paveS[0], Math.min(B.x1, b), SITE_ST.paveS[1], yR, 8);
  C.siteGaps = gaps;
}

// ---------------------------------------------------------------- roads (ribbons draped on the terrain)
const ROAD_W = {
  trunk: { w: 10 }, trunk_link: { w: 6.5 }, primary: { w: 9 }, primary_link: { w: 6 }, secondary: { w: 8 }, secondary_link: { w: 6 },
  tertiary: { w: 7 }, tertiary_link: { w: 5.5 }, unclassified: { w: 5.5 }, residential: { w: 5.6 }, living_street: { w: 5, foot: true },
  service: { w: 3.6 }, track: { w: 3, dirt: true }, footway: { w: 2, foot: true }, path: { w: 1.6, foot: true, dirt: true },
  pedestrian: { w: 4, foot: true }, steps: { w: 2, foot: true }, cycleway: { w: 2, foot: true }
};
const SIDEWALK = new Set(['trunk', 'primary', 'secondary', 'tertiary', 'unclassified', 'residential']);
function buildRoads(C, osm) {
  const inBand = (x, z) => inRect(x, z, SITE_BAND) || inRect(x, z, LOT_R);
  const ribbon = (key, P, o0, o1, up, S) => {
    const gb = () => C.chunks.gb(P[0][0], P[0][1], key);
    for (let i = 0; i < P.length - 1; i++) {
      const [ax, az] = P[i], [bx, bz] = P[i + 1];
      const L = Math.hypot(bx - ax, bz - az);
      if (L < 0.05) continue;
      const tx = (bx - ax) / L, tz = (bz - az) / L, nx = -tz, nz = tx;
      const n = Math.max(1, Math.ceil(L / 6));
      for (let k = 0; k < n; k++) {
        const t0 = k / n, t1 = (k + 1) / n;
        const x0 = ax + (bx - ax) * t0, z0 = az + (bz - az) * t0, x1 = ax + (bx - ax) * t1, z1 = az + (bz - az) * t1;
        if (inBand((x0 + x1) / 2 + nx * (o0 + o1) / 2, (z0 + z1) / 2 + nz * (o0 + o1) / 2)) continue;
        // extend each piece slightly along the road so joints between segments close
        const e = 0.3;
        const xa = x0 - tx * e, za = z0 - tz * e, xb = x1 + tx * e, zb = z1 + tz * e;
        const p = (x, z, o) => [x + nx * o, groundY(x + nx * o, z + nz * o) + up, z + nz * o];
        const A = p(xa, za, o0), B = p(xb, zb, o0), Cc = p(xb, zb, o1), D = p(xa, za, o1);
        const U = (q) => [q[0] / S, -q[2] / S];
        C.chunks.gb(x0, z0, key).quad(A, B, Cc, D, [U(A), U(B), U(Cc), U(D)], [0, 1, 0]);
      }
    }
  };
  for (const r of osm.r || []) {
    const spec = ROAD_W[r.k];
    if (!spec || !r.p || r.p.length < 2) continue;
    const w = r.w || (r.ln ? Math.max(spec.w, r.ln * 3.1) : spec.w);
    const near = r.p.some(([x, z]) => Math.hypot(x - 7, z - 7) < 900);
    if (spec.foot) ribbon(spec.dirt ? 'dirt' : 'calcada', r.p, -w / 2, w / 2, spec.dirt ? 0.05 : 0.08, spec.dirt ? 6 : 1.6);
    else if (spec.dirt) ribbon('dirt', r.p, -w / 2, w / 2, 0.05, 6);
    else {
      ribbon('asphalt', r.p, -w / 2, w / 2, 0.1, 8);
      if (SIDEWALK.has(r.k) && near) { ribbon('calcada', r.p, -w / 2 - 1.7, -w / 2, 0.07, 1.6); ribbon('calcada', r.p, w / 2, w / 2 + 1.7, 0.07, 1.6); }
    }
  }
}

// ---------------------------------------------------------------- railway (Linha do Alentejo / Ramal do Barreiro) + platforms
function buildRail(C, osm) {
  const lines = [];
  for (const r of osm.rail || []) {
    if (!r.p || r.p.length < 2) continue;
    if (r.k === 'rail') {
      const P = r.p;
      for (let i = 0; i < P.length - 1; i++) {
        const [ax, az] = P[i], [bx, bz] = P[i + 1];
        const L = Math.hypot(bx - ax, bz - az); if (L < 0.05) continue;
        const tx = (bx - ax) / L, tz = (bz - az) / L, nx = -tz, nz = tx;
        const n = Math.max(1, Math.ceil(L / 8));
        for (let k = 0; k < n; k++) {
          const x0 = ax + (bx - ax) * k / n, z0 = az + (bz - az) * k / n, x1 = ax + (bx - ax) * (k + 1) / n, z1 = az + (bz - az) * (k + 1) / n;
          const p = (x, z, o, up) => [x + nx * o, groundY(x + nx * o, z + nz * o) + up, z + nz * o];
          C.chunks.gb(x0, z0, 'plain').color([0.47, 0.43, 0.39]).quad(p(x0, z0, -1.7, 0.14), p(x1, z1, -1.7, 0.14), p(x1, z1, 1.7, 0.14), p(x0, z0, 1.7, 0.14), null, [0, 1, 0]);
          for (const o of [-0.72, 0.72]) lines.push(...p(x0, z0, o, 0.32), ...p(x1, z1, o, 0.32));
        }
      }
    } else if (r.k === 'platform' && r.p.length > 3 && r.p[0][0] === r.p[r.p.length - 1][0]) {
      const ring = r.p.slice(0, -1);
      const base = Math.min(...ring.map(([x, z]) => groundY(x, z)));
      const gb = C.chunks.gb(ring[0][0], ring[0][1], 'plain').color([0.78, 0.76, 0.72]);
      wallRing(gb.plain(true), ring, base - 0.5, base + 0.9, 0, 0);
      flatRoof(gb, ring, base + 0.9);
      gb.plain(false);
    }
  }
  if (lines.length) {
    const g = new T.BufferGeometry(); g.setAttribute('position', new T.Float32BufferAttribute(lines, 3));
    const m = new T.LineSegments(g, new T.LineBasicMaterial({ color: '#5d5a57' }));
    m.name = 'env-rails'; C.group.add(m);
  }
}

// ---------------------------------------------------------------- buildings
// walls of a footprint ring with the façade atlas (bays snapped per edge); out-facing whatever the ring winding
function wallRing(gb, ring, base, top, sink, uoff, storeyH = STOREY) {
  const cw = ringArea(ring) < 0;
  const vs = (y) => (y - base) / storeyH / 4;
  let u = uoff;
  for (let i = 0; i < ring.length; i++) {
    const [ax, az] = ring[i], [bx, bz] = ring[(i + 1) % ring.length];
    const L = Math.hypot(bx - ax, bz - az); if (L < 0.05) continue;
    // outward normal: for CCW (positive area in x,z) rings the right-hand normal (dz, -dx) points out
    let nx = (bz - az) / L, nz = -(bx - ax) / L;
    if (cw) { nx = -nx; nz = -nz; }
    const nb = Math.max(1, Math.round(L / BAY)) / 4;
    if (gb.fixUV) gb.quad([ax, base - sink, az], [bx, base - sink, bz], [bx, top, bz], [ax, top, az], null, [nx, 0, nz]);
    else {
      gb.quad([ax, base, az], [bx, base, bz], [bx, top, bz], [ax, top, az], [[u, 0], [u + nb, 0], [u + nb, vs(top)], [u, vs(top)]], [nx, 0, nz]);
      if (sink > 0) { gb.plain(true); gb.quad([ax, base - sink, az], [bx, base - sink, bz], [bx, base, bz], [ax, base, az], null, [nx, 0, nz]); gb.plain(false); }
    }
    u += nb;
  }
}
function flatRoof(gb, ring, y) {
  const pts = ring.map(([x, z]) => new T.Vector2(x, z));
  let tris = [];
  try { tris = T.ShapeUtils.triangulateShape(pts, []); } catch (e) { return; }
  for (const [a, b, c] of tris) gb.tri([ring[a][0], y, ring[a][1]], [ring[b][0], y, ring[b][1]], [ring[c][0], y, ring[c][1]], [0, 0], [1, 0], [0, 1], [0, 1, 0]);
}
// minimum-area oriented bounding box
function obb(ring) {
  let best = null;
  for (let i = 0; i < ring.length; i++) {
    const [ax, az] = ring[i], [bx, bz] = ring[(i + 1) % ring.length];
    const L = Math.hypot(bx - ax, bz - az); if (L < 0.5) continue;
    const ux = (bx - ax) / L, uz = (bz - az) / L;
    let u0 = Infinity, u1 = -Infinity, v0 = Infinity, v1 = -Infinity;
    for (const [x, z] of ring) { const u = x * ux + z * uz, v = -x * uz + z * ux; u0 = Math.min(u0, u); u1 = Math.max(u1, u); v0 = Math.min(v0, v); v1 = Math.max(v1, v); }
    const area = (u1 - u0) * (v1 - v0);
    if (!best || area < best.area) best = { area, ux, uz, u0, u1, v0, v1 };
  }
  if (!best) return null;
  const cu = (best.u0 + best.u1) / 2, cv = (best.v0 + best.v1) / 2;
  best.cx = cu * best.ux - cv * best.uz; best.cz = cu * best.uz + cv * best.ux;
  best.len = best.u1 - best.u0; best.wid = best.v1 - best.v0;
  best.ang = Math.atan2(best.uz, best.ux);
  return best;
}
function buildOSMBuildings(C, osm, rng, low) {
  const list = osm.b || [];
  const cov = C.cov;
  list.forEach((b, idx) => {
    if (!b.p || b.p.length < 4) return;
    const ring = b.p.slice(0, -1);
    let cx = 0, cz = 0; for (const [x, z] of ring) { cx += x; cz += z; } cx /= ring.length; cz /= ring.length;
    cov.mark(cx, cz);
    if (inRect(cx, cz, WEST_R) || inRect(cx, cz, EAST_R) || inRect(cx, cz, LOT_R)) return;
    const area = Math.abs(ringArea(ring));
    if (area < 4) return;
    const k = b.k || 'yes', hsh = hash(idx * 31 + 7);
    let storeys = 2, style = 'house', flat = false, windows = true;
    if (k === 'apartments') { storeys = 4; style = 'block'; }
    else if (k === 'house' || k === 'terrace' || k === 'detached' || k === 'semidetached_house') storeys = hsh < 0.15 ? 1 : 2;
    else if (k === 'yes' || k === 'residential') {
      if (area < 180) storeys = hsh < 0.18 ? 1 : 2;
      else if (area < 400) { storeys = hsh < 0.5 ? 3 : 4; style = 'block'; }
      else { storeys = 4; style = 'block'; }
    } else if (k === 'shed' || k === 'garages' || k === 'garage' || k === 'ruins' || k === 'service') { storeys = 1; flat = true; windows = false; }
    else if (k === 'school') { storeys = hsh < 0.5 ? 2 : 3; flat = true; style = 'school'; }
    else if (k === 'industrial' || k === 'warehouse') { storeys = 3; flat = true; windows = false; style = 'industrial'; }
    else if (k === 'roof') { storeys = 0; }
    if (b.l) storeys = Math.max(1, Math.min(20, parseInt(b.l, 10) || storeys));
    const G = ring.map(([x, z]) => groundY(x, z));
    const base = Math.min(...G), gmax = Math.max(...G);
    const H = b.h ? +b.h : style === 'industrial' ? 8 + hsh * 2 : storeys * STOREY + 0.3;
    const top = gmax + H;
    const d0 = Math.hypot(cx - 7, cz - 7);
    const key = d0 < 70 ? 'nearOSM' : '';
    const gbOf = (m) => key ? C.near['osm_' + m] : C.chunks.gb(cx, cz, m);
    if (k === 'roof') { // canopy: slab on the ground's highest point + 3 m
      const gb = gbOf('plain').color([0.8, 0.79, 0.76]);
      flatRoof(gb, ring, gmax + 3); return;
    }
    // modern grey/white houses right behind the lot (site-plot.jpg)
    const modern = cx > 5 && cx < 30 && cz > -35 && cz < -8;
    let col;
    if (b.bc) col = new T.Color(b.bc);
    else if (modern) col = new T.Color('#f2f2f0');
    else if (style === 'block') col = new T.Color(BLOCK_COLS[(hsh * 997 | 0) % BLOCK_COLS.length]);
    else if (style === 'industrial') col = new T.Color('#d8d5cd');
    else if (style === 'school') col = new T.Color('#efe5cf');
    else col = new T.Color(HOUSE_COLS[(hsh * 991 | 0) % HOUSE_COLS.length]);
    const fg = gbOf('facade');
    const sink = gmax - base + 1.0;
    const uoff = ((hsh * 13) | 0) % 4 / 4;
    if (modern) {
      fg.color(new T.Color('#7b8086')); wallRing(fg, ring, gmax, gmax + STOREY, sink, uoff);
      fg.color(col); wallRing(fg, ring, gmax + STOREY, top, 0, uoff);
      flat = true;
    } else {
      fg.color(col);
      if (!windows) { fg.plain(true); wallRing(fg, ring, gmax, top, sink, 0); fg.plain(false); }
      else wallRing(fg, ring, gmax, top, sink, uoff);
    }
    const box = obb(ring);
    const rectLike = box && area / box.area > 0.86 && ring.length <= 8 && box.wid > 3;
    if (!flat && rectLike) {
      const rc = new T.Color(b.rc || ROOF_COLS[(hsh * 577 | 0) % ROOF_COLS.length]);
      const rg = gbOf('roof').color(rc);
      const s0 = rg.p.length;
      const hl = box.len / 2, hw = box.wid / 2;
      hipRoof(rg, -hl, -hw, hl, hw, 0, style === 'block' ? 0.3 : 0.42, 0.35);
      rg.xform(s0, new T.Matrix4().makeRotationY(-box.ang).setPosition(box.cx, top, box.cz));
      // soffit / eave band
      const pg = gbOf('plain').color([0.92, 0.91, 0.89]);
      const s1 = pg.p.length;
      pg.box(-hl - 0.35, -0.18, -hw - 0.35, hl + 0.35, 0, hw + 0.35, 1, { top: true });
      pg.xform(s1, new T.Matrix4().makeRotationY(-box.ang).setPosition(box.cx, top, box.cz));
      // yellow balconies of the 1970s blocks, on both long façades
      if (style === 'block' && !low && d0 < 650 && storeys >= 3 && box.len > 12) {
        const yb = gbOf('plain');
        const yellow = hsh < 0.75 ? [0.93, 0.77, 0.3] : [0.94, 0.9, 0.82];
        const nb = Math.floor(box.len / 6.4);
        const s2 = yb.p.length;
        for (const side of [-1, 1]) for (let q = 0; q < nb; q++) {
          if ((q + (side > 0 ? 0 : 1)) % 2) continue;
          const a0 = -hl + (box.len - nb * 6.4) / 2 + q * 6.4 + 0.6, a1 = a0 + 5.2;
          for (let f = 1; f < storeys; f++) {
            const y = gmax - top + f * STOREY - 0.1;
            const v0 = side > 0 ? hw : -hw - 1.25, v1 = side > 0 ? hw + 1.25 : -hw;
            yb.color(yellow).box(a0, y, v0, a1, y + 1.05, v1, 1, { bottom: false });
          }
        }
        yb.xform(s2, new T.Matrix4().makeRotationY(-box.ang).setPosition(box.cx, top, box.cz));
      }
    } else {
      const pg = gbOf('plain').color(modern ? [0.94, 0.94, 0.93] : style === 'industrial' ? [0.66, 0.66, 0.64] : [0.82, 0.8, 0.77]);
      flatRoof(pg, ring, top);
      // parapet
      pg.plain(true); wallRing(pg, ring, top, top + 0.45, 0, 0); pg.plain(false);
    }
  });
}

// ---------------------------------------------------------------- walls, fences (OSM barriers near the site)
function buildBarriers(C, osm) {
  for (const b of osm.bar || []) {
    if (!b.p || b.p.length < 2 || b.k === 'kerb') continue;
    const P = b.p.map(([x, z]) => {
      // keep boundary walls just outside the lot (the building's walls sit on x = 0 … 13.88)
      if (Math.abs(x - 13.9) < 0.45 && z > -8.5 && z < 17.6) x = 14.3;
      if (Math.abs(x + 0.3) < 0.45 && z > -8.5 && z < 17.6) x = -0.4;
      return [x, z];
    });
    for (let i = 0; i < P.length - 1; i++) {
      const [ax, az] = P[i], [bx, bz] = P[i + 1];
      const L = Math.hypot(bx - ax, bz - az); if (L < 0.1) continue;
      const mx = (ax + bx) / 2, mz = (az + bz) / 2;
      if (mz > 15.5 && mx > 13 && mx < 31.5) continue;               // east neighbour's front wall is hand-modelled
      if (inRect(mx, mz, LOT_R) && !(Math.abs(mz - LOT.zRear) < 0.6)) continue;
      const y0 = groundY(mx, mz);
      if (b.k === 'wall') {
        const H = 2.2;
        C.near.plain.color([0.95, 0.945, 0.93]).rbox(mx, mz, L + 0.2, 0.22, y0 - 0.4, y0 + H, -Math.atan2(bz - az, bx - ax));
        C.near.plain.color([0.85, 0.84, 0.81]).rbox(mx, mz, L + 0.26, 0.3, y0 + H, y0 + H + 0.06, -Math.atan2(bz - az, bx - ax));
      } else C.fenceQuads.push({ a: [ax, y0, az], b: [bx, groundY(bx, bz), bz], h: 1.6 });
    }
  }
}

// ---------------------------------------------------------------- trees and parked cars from the map
function buildOSMTrees(C, osm, rng, low) {
  (osm.t || []).forEach(([x, z], i) => {
    if (inRect(x, z, LOT_R) || inRect(x, z, SITE_BAND)) return;
    const h = hash(i * 17 + 3);
    addTree(C, x, z, 0.75 + h * 0.55, h < 0.72 ? 0 : h < 0.88 ? 2 : 1);
  });
  // parks & gardens: fill with trees (the map only has some of them)
  for (const l of [...(osm.g || []), ...(osm.lu || [])]) {
    if (!['park', 'garden', 'recreation_ground', 'grass', 'cemetery'].includes(l.k) || !l.p || l.p.length < 4) continue;
    const area = Math.abs(ringArea(l.p));
    if (area < 300) continue;
    let x0 = Infinity, x1 = -Infinity, z0 = Infinity, z1 = -Infinity;
    for (const [x, z] of l.p) { x0 = Math.min(x0, x); x1 = Math.max(x1, x); z0 = Math.min(z0, z); z1 = Math.max(z1, z); }
    if (Math.hypot((x0 + x1) / 2 - 7, (z0 + z1) / 2 - 7) > 1100) continue;
    const n = Math.min(low ? 12 : 30, Math.floor(area / (l.k === 'grass' ? 700 : 220)));
    for (let i = 0, tries = 0; i < n && tries < n * 6; tries++) {
      const x = lerp(x0, x1, rng()), z = lerp(z0, z1, rng());
      if (!inPoly(l.p, x, z) || C.bIndex.inside(x, z, 2) || inRect(x, z, LOT_R)) continue;
      const k = rng();
      addTree(C, x, z, 0.8 + rng() * 0.6, k < 0.6 ? 0 : k < 0.85 ? 2 : 1); i++;
    }
  }
}
function buildOSMCars(C, osm, rng, low) {
  for (const r of osm.r || []) {
    if (!['residential', 'tertiary', 'unclassified', 'secondary'].includes(r.k) || !r.p) continue;
    const w = (r.w || ROAD_W[r.k].w) / 2;
    const P = r.p;
    let acc = 0;
    for (let i = 0; i < P.length - 1; i++) {
      const [ax, az] = P[i], [bx, bz] = P[i + 1];
      const L = Math.hypot(bx - ax, bz - az); if (L < 1) continue;
      const tx = (bx - ax) / L, tz = (bz - az) / L;
      for (let s = 9; s < L - 9; s += 5.4) {
        const x = ax + tx * s, z = az + tz * s;
        if (Math.hypot(x - 7, z - 7) > (low ? 200 : 320) || inRect(x, z, SITE_BAND)) continue;
        for (const side of [-1, 1]) {
          if (rng() > 0.3) continue;
          const px = x - tz * side * (w - 1.0), pz = z + tx * side * (w - 1.0);
          if (C.bIndex.inside(px, pz, 1.6)) continue;
          C.cars.push({ x: px, z: pz, ry: -Math.atan2(tz, tx) + (side > 0 ? Math.PI : 0), col: rng(), y: groundY(px, pz) + 0.1 });
        }
      }
      acc += L;
    }
  }
}

// spatial index of footprints (point-in-building tests)
function buildingIndex(osm) {
  const cell = 40, map = new Map();
  const key = (i, j) => i * 65536 + j;
  (osm.b || []).forEach((b) => {
    if (!b.p || b.p.length < 4) return;
    let x0 = Infinity, x1 = -Infinity, z0 = Infinity, z1 = -Infinity;
    for (const [x, z] of b.p) { x0 = Math.min(x0, x); x1 = Math.max(x1, x); z0 = Math.min(z0, z); z1 = Math.max(z1, z); }
    for (let i = Math.floor(x0 / cell); i <= Math.floor(x1 / cell); i++) for (let j = Math.floor(z0 / cell); j <= Math.floor(z1 / cell); j++) {
      const k = key(i, j); if (!map.has(k)) map.set(k, []); map.get(k).push({ p: b.p, x0, x1, z0, z1 });
    }
  });
  return {
    inside(x, z, pad = 0) {
      const l = map.get(key(Math.floor(x / cell), Math.floor(z / cell)));
      if (!l) return false;
      for (const b of l) {
        if (x < b.x0 - pad || x > b.x1 + pad || z < b.z0 - pad || z > b.z1 + pad) continue;
        if (pad === 0) { if (inPoly(b.p, x, z)) return true; }
        else if (inPoly(b.p, x, z) || inPoly(b.p, x + pad, z) || inPoly(b.p, x - pad, z) || inPoly(b.p, x, z + pad) || inPoly(b.p, x, z - pad)) return true;
      }
      return false;
    }
  };
}
// coarse coverage grid of the OSM extract (filler towns stay outside it)
function coverageGrid() {
  const cell = 60, set = new Set();
  const k = (i, j) => i * 65536 + j;
  return {
    mark(x, z) { const i = Math.floor(x / cell), j = Math.floor(z / cell); for (let a = -2; a <= 2; a++) for (let b = -2; b <= 2; b++) set.add(k(i + a, j + b)); },
    has(x, z) { return set.has(k(Math.floor(x / cell), Math.floor(z / cell))); }
  };
}

// ---------------------------------------------------------------- main
export function buildEnvironment(THREE, { scene, renderer, quality = 'high' } = {}) {
  T = THREE;
  const low = quality === 'low';
  const group = new T.Group();
  group.name = 'environment';
  const rng = rngFrom(0x5EED2835);
  const aniso = renderer && renderer.capabilities ? Math.min(8, renderer.capabilities.getMaxAnisotropy()) : 4;
  const C = { group, mats: {}, chunks: new Chunks(420), cars: [], trees: [], ironQuads: [], fenceQuads: [], low };
  C.cov = coverageGrid(); C.covered = (x, z) => C.cov.has(x, z);
  C.bIndex = { inside: () => false };
  const safe = (name, fn) => { try { fn(); } catch (e) { console.warn('[environment] ' + name, e); } };

  const tex = makeTextures(rng, aniso);
  const fac = makeFacadeTextures(rng, low ? 512 : 1024, aniso);
  makeMaterials(C, tex, fac);
  const newNear = () => ({ facade: new GB(), plain: new GB(), roof: new GB(), stone: new GB(), yard: new GB(), metal: new GB(),
    ground: new GB(), asphalt: new GB(), calcada: new GB(), osm_facade: new GB(), osm_plain: new GB(), osm_roof: new GB() });
  C.near = newNear();
  // far scenery (Lisbon, bridges, Cristo Rei) authored in the phase-1 frame, mapped onto the local frame
  C.far = new T.Group();
  C.far.name = 'env-far-scenery';
  C.far.position.set(FAR_XFORM.tx, 0, FAR_XFORM.tz);
  C.far.rotation.y = FAR_XFORM.ry;
  group.add(C.far);

  // --- sky, lights, fog
  const sky = makeSky();
  group.add(sky);
  const sun = new T.DirectionalLight(0xffffff, 3);
  sun.name = 'env-sun';
  sun.castShadow = true;
  sun.shadow.mapSize.set(low ? 1024 : 2048, low ? 1024 : 2048);
  Object.assign(sun.shadow.camera, { left: -25, right: 25, top: 25, bottom: -25, near: 1, far: 220 });
  sun.shadow.bias = -0.0004;
  sun.shadow.normalBias = 0.03;
  sun.shadow.radius = 3;
  sun.target.position.set(7, 0, 7);
  group.add(sun, sun.target);
  const hemi = new T.HemisphereLight(0xbcd6f0, 0xb59e82, 0.5);
  hemi.name = 'env-hemisphere';
  group.add(hemi);
  scene.fog = new T.FogExp2(0xc9dcef, 0.00006);
  safe('water', () => group.add(buildWater(C)));
  safe('bridges', () => buildBridges(C));
  scene.add(group);

  const lampLights = [];
  const flushNear = () => {
    const names = { osm_facade: 'facade', osm_plain: 'plain', osm_roof: 'roof' };
    for (const k in C.near) {
      if (C.near[k].empty) continue;
      const mat = C.mats[names[k] || k];
      const m = new T.Mesh(C.near[k].build(), mat);
      m.name = `env-near-${k}`;
      m.castShadow = k !== 'ground' && k !== 'asphalt' && k !== 'calcada';
      m.receiveShadow = true;
      group.add(m);
    }
    C.near = newNear();
  };
  // --- the real neighbourhood (async: data/osm.json, ~0.7 MB)
  const buildContext = (osm) => {
    const data = osm || {};
    setDEM(data.terrain);
    C.bIndex = buildingIndex(data);
    safe('terrain', () => { C.mats.terrainInner.map = paintGround(data, rngFrom(77)); C.mats.terrainInner.needsUpdate = true; group.add(buildTerrain(C, low)); });
    safe('site-ground', () => buildSiteGround(C, data));
    safe('roads', () => buildRoads(C, data));
    safe('rail', () => buildRail(C, data));
    safe('buildings', () => buildOSMBuildings(C, data, rng, low));
    safe('barriers', () => buildBarriers(C, data));
    safe('neighbours', () => buildNeighbours(C, rng));
    safe('street-furniture', () => buildStreetFurniture(C, rng));
    safe('osm-trees', () => buildOSMTrees(C, data, rng, low));
    // parked cars on Rua Eduardo Couto (keep the lot frontage clear), then along the real streets nearby
    const zParkS = SITE_ST.road[1] - 1.05, zParkN = SITE_ST.road[0] + 1.05;
    for (const [x, z, ry, col] of [[-31.5, zParkS, Math.PI, 0.1], [-25.2, zParkS, Math.PI, 0.35], [21.5, zParkS, Math.PI, 0.52], [27.3, zParkS, Math.PI, 0.03],
      [-19, zParkN, 0, 0.61], [-12.4, zParkN, 0, 0.21], [24.5, zParkN, 0, 0.83]]) C.cars.push({ x, z, ry, col, y: ROAD_UP + TERR_FLAT });
    safe('osm-cars', () => buildOSMCars(C, data, rng, low));
    safe('trees', () => buildTrees(C));
    safe('cars', () => buildCars(C));
    safe('alpha', () => buildAlphaQuads(C));
    safe('far-city', () => buildFarCity(C, rng, low));
    safe('meshes', () => { C.chunks.meshes(C.mats, group, { cast: () => false, receive: true }); flushNear(); });
    // two warm point lights at the street lamps nearest the entrance (dusk only; intensity 0 otherwise)
    safe('lamp-lights', () => {
      const near = (C.lampPts || []).slice().sort((a, b) => Math.hypot(a[0] - 7, a[2] - 18) - Math.hypot(b[0] - 7, b[2] - 18)).slice(0, 2);
      for (const [x, y, z] of near) {
        const L = new T.PointLight(0xffb46b, 0, 28, 1.6);
        L.position.set(x, y - 0.3, z);
        L.name = 'env-streetlamp-light';
        group.add(L); lampLights.push(L);
      }
    });
    setTimeOfDay(current);
  };
  const ready = (async () => {
    await null;
    let osm = null;
    try {
      const url = new URL('../data/osm.json', import.meta.url);
      const res = await fetch(url);
      if (res.ok) osm = await res.json();
    } catch (e) { console.warn('[environment] osm.json unavailable, using the land mask only', e); }
    buildContext(osm);
    return !!osm;
  })();

  // --- time of day
  const col = (h) => new T.Color(h);
  let current = 'golden';
  let envFactor = 1;
  const applyEnvFactor = () => {
    scene.traverse(o => {
      if (!o.isMesh || !o.material) return;
      const list = Array.isArray(o.material) ? o.material : [o.material];
      for (const m of list) {
        if (m.envMapIntensity === undefined || m.userData.envSkip) continue;
        if (m.userData.envBase === undefined) m.userData.envBase = m.envMapIntensity;
        m.envMapIntensity = m.userData.envBase * envFactor;
      }
    });
  };
  function setTimeOfDay(name) {
    const P = TOD[name] || TOD.golden;
    current = TOD[name] ? name : 'golden';
    const d = sunDirection(P.az, P.alt);
    sun.position.set(7 + d.x * 120, Math.max(d.y, 0.035) * 120, 7 + d.z * 120);
    sun.color.set(P.sun); sun.intensity = P.sunI;
    const U = sky.material.uniforms;
    U.zenith.value.set(P.zenith); U.horizon.value.set(P.horizon); U.horizonAway.value.set(P.away); U.mid.value.set(P.mid); U.ground.value.set(P.fogCol);
    U.glowCol.value.set(P.glow); U.sunCol.value.set(P.sun).multiplyScalar(P.sunDisc); U.sunDir.value.copy(d);
    U.cloudCover.value = P.cloud; U.cloudLit.value.set(P.cloudLit); U.cloudShade.value.set(P.cloudShade); U.stars.value = P.stars;
    hemi.color.set(P.hemiSky); hemi.groundColor.set(P.hemiGround); hemi.intensity = P.hemiI;
    scene.fog.color.set(P.fogCol); scene.fog.density = P.fog;
    scene.background = col(P.fogCol);
    const W = C.mats.water && C.mats.water.uniforms;
    if (W) {
      W.deep.value.set(P.water); W.skyLow.value.set(P.waterSky); W.skyHigh.value.set(P.zenith);
      W.sunCol.value.set(P.sun).multiplyScalar(P.alt > 0 ? 1 : 0.3); W.sunDir.value.copy(d); W.lights.value = P.city;
    }
    const M = C.mats;
    M.facade.emissiveIntensity = P.lamps * 1.4;
    M.city.emissiveIntensity = P.city * 2.2;
    M.lights.opacity = P.city; M.redLights.opacity = P.city;
    M.lampHead.emissiveIntensity = P.lamps * 6;
    M.glow.opacity = P.lamps * 0.6; M.pool.opacity = P.lamps * 0.13;
    M.glassDark.emissiveIntensity = P.lamps * 0.8;
    M.cable.color.set(name === 'dusk' ? '#0b0c10' : '#202224');
    for (const L of lampLights) L.intensity = P.lamps * 22;
    envFactor = P.env;
    applyEnvFactor();
  }

  function geo(lat, lon) {
    const [x, z] = geoXZ(lat, lon);
    return new T.Vector3(x, Math.max(WATER_Y, heightAt(x, z)), z);
  }

  let time = 0, envTimer = 0;
  function update(dt = 0.016, camera) {
    time += Math.min(dt || 0, 0.1);
    if (camera) sky.position.copy(camera.getWorldPosition ? camera.getWorldPosition(new T.Vector3()) : camera.position);
    sky.material.uniforms.time.value = time;
    if (C.mats.water) C.mats.water.uniforms.time.value = time;
    envTimer += dt || 0;
    if (envTimer > 2) { envTimer = 0; if (envFactor !== 1) applyEnvFactor(); } // materials added later (interiors) get the same factor
  }

  setTimeOfDay('golden');

  return {
    group, sun, hemi, setTimeOfDay, geo, update, ready,
    attribution: '© OpenStreetMap contributors (ODbL) · EU-DEM (Copernicus)',
    get timeOfDay() { return current; },
    heightAt: (x, z) => groundY(x, z),
    waterY: WATER_Y,
    street: { zKerb: STREET.zKerb, zRoad0: SITE_ST.road[0], zRoad1: SITE_ST.road[1], zFar: SITE_ST.paveS[1], pavementY: PAVE_Y, roadY: TERR_FLAT + ROAD_UP }
  };
}
