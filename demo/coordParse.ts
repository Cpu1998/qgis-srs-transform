/**
 * Coordinate text parsing (ported from the DXApp coordinate-location widget).
 *
 * Two parse paths, mirroring how the widget reads its input box:
 * - `parseCoordinates`: geographic text — decimal degrees, DMS/DM, E/W/N/S
 *   markers, "纬度在前" auto-detection, optional third field as height.
 * - `parseRawNumberPairs`: plain numeric pairs/triples for projected (metric)
 *   and geocentric input, where ±180/±90 range checks must not apply.
 */

/** A parsed geographic point (degrees). */
export interface ParsedCoordinate {
  longitude: number;
  latitude: number;
  /** Height in meters when the input carried a third numeric field. */
  height?: number;
}

/** A plain numeric pair/triple (projected or geocentric axes). */
export interface RawNumberPair {
  x: number;
  y: number;
  z?: number;
}

function toFiniteNumber(raw: string): number | undefined {
  const value = Number(raw);
  return Number.isFinite(value) ? value : undefined;
}

function isValidCoord(lng: number, lat: number): boolean {
  return lng >= -180 && lng <= 180 && lat >= -90 && lat <= 90;
}

function dmsToDD(degrees: number, minutes: number, seconds: number): number {
  const sign = degrees < 0 ? -1 : 1;
  return sign * (Math.abs(degrees) + minutes / 60 + seconds / 3600);
}

function dmToDD(degrees: number, minutes: number): number {
  const sign = degrees < 0 ? -1 : 1;
  return sign * (Math.abs(degrees) + minutes / 60);
}

/**
 * Parse one axis value: `118.775139`, `118°46'30.5"`, `118°46.508'`,
 * or the same without trailing symbols.
 */
function parseSingleCoord(str: string): number | null {
  str = str.trim();
  if (!str) return null;

  const dmsMatch = str.match(/(-?\d+(?:\.\d+)?)\s*[°˚º]\s*(\d+(?:\.\d+)?)\s*['′']\s*(\d+(?:\.\d+)?)\s*["″""]?/);
  if (dmsMatch) return dmsToDD(parseFloat(dmsMatch[1]), parseFloat(dmsMatch[2]), parseFloat(dmsMatch[3]));

  const dmMatch = str.match(/(-?\d+(?:\.\d+)?)\s*[°˚º]\s*(\d+(?:\.\d+)?)\s*['′']?/);
  if (dmMatch) return dmToDD(parseFloat(dmMatch[1]), parseFloat(dmMatch[2]));

  const ddMatch = str.match(/^(-?\d+(?:\.\d+)?)$/);
  if (ddMatch) {
    const val = parseFloat(ddMatch[1]);
    if (val >= -180 && val <= 180) return val;
  }
  return null;
}

/** Accept lat-first input: swap only when the direct order is invalid (e.g. "32.04, 118.78"). */
function normalizeOrder(first: number, second: number): ParsedCoordinate | null {
  if (isValidCoord(first, second)) return { longitude: first, latitude: second };
  if (isValidCoord(second, first)) return { longitude: second, latitude: first };
  return null;
}

function parseCoordinatePair(str: string): ParsedCoordinate | null {
  str = str.trim();
  if (!str) return null;

  const commaParts = str.split(',').map((s) => s.trim()).filter(Boolean);
  if (commaParts.length >= 2) {
    const first = parseSingleCoord(commaParts[0]);
    const second = parseSingleCoord(commaParts[1]);
    if (first !== null && second !== null) {
      const coordinate = normalizeOrder(first, second);
      // Height has no DMS notation: only a plain decimal third field counts.
      const height = commaParts.length >= 3 ? toFiniteNumber(commaParts[2]) : undefined;
      if (coordinate) {
        coordinate.height = height;
        return coordinate;
      }
    }
  }

  const spaceParts = str.split(/[\s\t]+/).map((s) => s.trim()).filter(Boolean);
  if (spaceParts.length >= 2) {
    const first = parseSingleCoord(spaceParts[0]);
    const second = parseSingleCoord(spaceParts[1]);
    if (first !== null && second !== null) {
      const coordinate = normalizeOrder(first, second);
      const height = spaceParts.length >= 3 ? toFiniteNumber(spaceParts[2]) : undefined;
      if (coordinate) {
        coordinate.height = height;
        return coordinate;
      }
    }
  }

  const dmsPair = str.match(
    /(-?\d+\s*[°˚º]\s*\d+\s*['′']\s*[\d.]+\s*["″""]?)\s*[,\s]\s*(-?\d+\s*[°˚º]\s*\d+\s*['′']\s*[\d.]+\s*["″""]?)/,
  );
  if (dmsPair) {
    const first = parseSingleCoord(dmsPair[1]);
    const second = parseSingleCoord(dmsPair[2]);
    if (first !== null && second !== null) {
      const coordinate = normalizeOrder(first, second);
      if (coordinate) return coordinate;
    }
  }
  return null;
}

/** Parse `[[lng, lat], ...]` JSON paste. */
function tryParseArrayFormat(text: string): ParsedCoordinate[] {
  const results: ParsedCoordinate[] = [];
  const trimmed = text.trim();
  if (!trimmed.startsWith('[[')) return results;
  try {
    const parsed: unknown = JSON.parse(trimmed);
    if (!Array.isArray(parsed)) return results;
    for (const item of parsed) {
      if (Array.isArray(item) && item.length >= 2) {
        const lng = parseFloat(item[0]);
        const lat = parseFloat(item[1]);
        if (!isNaN(lng) && !isNaN(lat) && isValidCoord(lng, lat)) {
          const height = typeof item[2] === 'number' && Number.isFinite(item[2]) ? item[2] : undefined;
          results.push({ longitude: lng, latitude: lat, height });
        }
      }
    }
  } catch {
    // not JSON — fall through to plain parsing
  }
  return results;
}

/**
 * Extract geographic points from free text: decimal degrees, DMS/DM, mixed
 * label forms (`经度118.77 纬度32.06`, `E 118.77 N 32.06`), `[[lng,lat],…]`
 * arrays, and multiple pairs separated by `;` or newlines.
 */
export function parseCoordinates(text: string): ParsedCoordinate[] {
  const results: ParsedCoordinate[] = [];
  if (!text.trim()) return results;

  const arrayCoords = tryParseArrayFormat(text);
  if (arrayCoords.length > 0) return arrayCoords;

  const normalized = text
    .replace(/，/g, ',')
    .replace(/；/g, ';')
    .replace(/：/g, ':')
    .replace(/经度/gi, '')
    .replace(/纬度/gi, '')
    .replace(/longitude/gi, '')
    .replace(/latitude/gi, '')
    .replace(/lng/gi, '')
    .replace(/lat/gi, '')
    .replace(/[EeWw]/g, '')
    .replace(/[NnSs]/g, '');

  const pairs = normalized.split(/[;\n]+/).map((s) => s.trim()).filter(Boolean);
  for (const pair of pairs) {
    const coord = parseCoordinatePair(pair);
    if (coord) results.push(coord);
  }
  return results;
}

/**
 * Extract plain numeric pairs/triples without range checks — projected and
 * geocentric values reach millions and must not be validated as degrees.
 * Splits on `;`/newlines, pairs up single-value lines (table column paste),
 * strips wrapping brackets, and carries a third field as `z`.
 */
export function parseRawNumberPairs(text: string): RawNumberPair[] {
  const results: RawNumberPair[] = [];
  if (!text.trim()) return results;

  const segments = text
    .replace(/，/g, ',')
    .replace(/；/g, ';')
    .split(/[;\n]+/)
    .map((segment) => segment.trim())
    .filter(Boolean);

  /** Buffer of a lone numeric line; two in a row pair up (x then y). */
  let pending: number | undefined;

  for (const segment of segments) {
    const unwrapped = segment.replace(/^\[+/, '').replace(/\]+$/, '').trim();
    const parts = unwrapped.split(/[,\s\t]+/).map((part) => part.trim()).filter(Boolean);

    if (parts.length >= 2) {
      const x = toFiniteNumber(parts[0]);
      const y = toFiniteNumber(parts[1]);
      if (x === undefined || y === undefined) continue;
      // ECEF input needs all three axes; keep z when present.
      const z = parts.length >= 3 ? toFiniteNumber(parts[2]) : undefined;
      results.push(z !== undefined ? { x, y, z } : { x, y });
      pending = undefined;
      continue;
    }

    if (parts.length === 1) {
      const value = toFiniteNumber(parts[0]);
      if (value === undefined) continue;
      if (pending === undefined) pending = value;
      else {
        results.push({ x: pending, y: value });
        pending = undefined;
      }
    }
  }
  return results;
}
