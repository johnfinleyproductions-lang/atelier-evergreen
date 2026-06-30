// lib/palette.ts — Atelier Style Library: REAL palette extraction.
//
// This is the load-bearing honesty guarantee of the whole Style Library feature:
// the dominant colors of a reference image are extracted from ACTUAL PIXELS via
// the `sharp` package, NOT guessed by a vision model. The profiler (style VL
// layer) may stub other fields, but the palette is always real.
//
// extractPalette(input) -> Promise<{hex,weight}[]>
//   - input may be: a URL (fetched -> buffer), a base64 string (raw or data URI),
//     a Node Buffer / Uint8Array of image bytes, or a filesystem path.
//   - resizes the image to ~64px, reads raw RGB, runs a simple k-means (k=6),
//     and returns the cluster colors as { hex, weight } sorted DESC by weight
//     (weight is the fraction of sampled pixels in the cluster, 0..1).
//   - Pure + deterministic-ish (fixed seeding by spread initialization).
//   - On ANY failure (bad input, fetch error, decode error) returns [] — the
//     feature must never block on palette extraction.

import sharp from "sharp";

export type PaletteSwatch = { hex: string; weight: number };

const K = 6;
const SAMPLE_DIM = 64; // resize longest edge to ~64px before sampling
const MAX_ITERS = 12;

type RGB = [number, number, number];

/**
 * Extract the dominant palette from an image.
 * @param input URL, base64 (raw or data URI), image bytes, or a filesystem path.
 * @returns up to K swatches as { hex, weight } sorted descending by weight; [] on failure.
 */
export async function extractPalette(
  input: string | Buffer | Uint8Array,
): Promise<PaletteSwatch[]> {
  try {
    const bytes = await toBytes(input);
    if (!bytes || bytes.length === 0) return [];

    // Decode -> resize -> raw RGB (drop alpha) via sharp. REAL pixels.
    const { data, info } = await sharp(bytes)
      .resize(SAMPLE_DIM, SAMPLE_DIM, {
        fit: "inside",
        withoutEnlargement: true,
      })
      .removeAlpha()
      .raw()
      .toBuffer({ resolveWithObject: true });

    const channels = info.channels; // expected 3 after removeAlpha
    if (!data || data.length < channels || channels < 3) return [];

    const pixels: RGB[] = [];
    for (let i = 0; i + channels - 1 < data.length; i += channels) {
      pixels.push([data[i], data[i + 1], data[i + 2]]);
    }
    if (pixels.length === 0) return [];

    return kmeans(pixels, K);
  } catch {
    return [];
  }
}

// ---------------------------------------------------------------------------
// Input normalization: URL | data-URI/base64 | bytes | filesystem path
// ---------------------------------------------------------------------------

async function toBytes(
  input: string | Buffer | Uint8Array,
): Promise<Buffer | null> {
  if (input == null) return null;

  if (Buffer.isBuffer(input)) return input;
  if (input instanceof Uint8Array) return Buffer.from(input);

  if (typeof input === "string") {
    const s = input.trim();
    if (s.length === 0) return null;

    // data URI: data:image/png;base64,XXXX
    if (s.startsWith("data:")) {
      const comma = s.indexOf(",");
      if (comma === -1) return null;
      const meta = s.slice(5, comma);
      const payload = s.slice(comma + 1);
      if (meta.includes("base64")) return Buffer.from(payload, "base64");
      return Buffer.from(decodeURIComponent(payload), "utf8");
    }

    // remote URL
    if (/^https?:\/\//i.test(s)) {
      const res = await fetch(s);
      if (!res.ok) return null;
      const ab = await res.arrayBuffer();
      return Buffer.from(ab);
    }

    // file:// URL
    if (s.startsWith("file://")) {
      const { readFile } = await import("node:fs/promises");
      const { fileURLToPath } = await import("node:url");
      return readFile(fileURLToPath(s));
    }

    // raw base64 (heuristic: long, base64 alphabet only, no path separators)
    if (
      s.length > 64 &&
      !s.includes("/") &&
      !s.includes("\\") &&
      /^[A-Za-z0-9+/=\s]+$/.test(s)
    ) {
      const buf = Buffer.from(s, "base64");
      if (buf.length > 0) return buf;
    }

    // otherwise treat as a filesystem path
    const { readFile } = await import("node:fs/promises");
    return readFile(s);
  }

  return null;
}

// ---------------------------------------------------------------------------
// Simple k-means over RGB. Spread (deterministic) init, Euclidean distance.
// ---------------------------------------------------------------------------

function kmeans(pixels: RGB[], k: number): PaletteSwatch[] {
  const n = pixels.length;
  const realK = Math.min(k, n);

  // Deterministic spread initialization: pick evenly-spaced pixels.
  const centroids: RGB[] = [];
  for (let c = 0; c < realK; c++) {
    const idx = Math.floor((c * n) / realK) % n;
    centroids.push([...pixels[idx]] as RGB);
  }

  const assignment = new Int32Array(n).fill(-1);

  for (let iter = 0; iter < MAX_ITERS; iter++) {
    let changed = false;

    // Assign each pixel to the nearest centroid.
    for (let p = 0; p < n; p++) {
      const px = pixels[p];
      let best = 0;
      let bestDist = Infinity;
      for (let c = 0; c < realK; c++) {
        const d = dist2(px, centroids[c]);
        if (d < bestDist) {
          bestDist = d;
          best = c;
        }
      }
      if (assignment[p] !== best) {
        assignment[p] = best;
        changed = true;
      }
    }

    // Recompute centroids as the mean of assigned pixels.
    const sums = Array.from({ length: realK }, () => [0, 0, 0]);
    const counts = new Int32Array(realK);
    for (let p = 0; p < n; p++) {
      const a = assignment[p];
      const px = pixels[p];
      sums[a][0] += px[0];
      sums[a][1] += px[1];
      sums[a][2] += px[2];
      counts[a]++;
    }
    for (let c = 0; c < realK; c++) {
      if (counts[c] === 0) continue; // keep empty cluster's old centroid
      centroids[c] = [
        sums[c][0] / counts[c],
        sums[c][1] / counts[c],
        sums[c][2] / counts[c],
      ];
    }

    if (!changed) break;
  }

  // Final counts -> weights.
  const counts = new Int32Array(realK);
  for (let p = 0; p < n; p++) counts[assignment[p]]++;

  const swatches: PaletteSwatch[] = [];
  for (let c = 0; c < realK; c++) {
    if (counts[c] === 0) continue;
    swatches.push({
      hex: toHex(centroids[c]),
      weight: counts[c] / n,
    });
  }

  swatches.sort((a, b) => b.weight - a.weight);
  return swatches;
}

function dist2(a: RGB, b: RGB): number {
  const dr = a[0] - b[0];
  const dg = a[1] - b[1];
  const db = a[2] - b[2];
  return dr * dr + dg * dg + db * db;
}

function toHex(rgb: RGB): string {
  const c = (v: number) =>
    Math.max(0, Math.min(255, Math.round(v)))
      .toString(16)
      .padStart(2, "0");
  return `#${c(rgb[0])}${c(rgb[1])}${c(rgb[2])}`;
}
