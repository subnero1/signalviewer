// Turning multi-million-sample channels into something uPlot can draw.
//
// uPlot's linear() path builder already collapses dense data to per-pixel
// min/max spans (see its `decimate = idx1 - idx0 >= xDim * 4` branch), so it
// renders without aliasing and we never decimate per redraw. What it can't do
// is avoid materialising an x value per sample — 15M samples would mean a
// 120MB Float64 x array — or avoid walking every point in view.
//
// So we do exactly one O(n) pass up front to shrink the series, then hand the
// result to uPlot untouched on every frame.
//
// Both builders return uPlot's data shape directly: [x, ch0, ch1, ...]. All
// channels share one x array, since they share a sample clock.

// Tuning knobs, not constants of nature — retune against a real 30s @ 500kSps
// file if frames run long. BUCKET trades peak-time accuracy for series size;
// RAW_THRESHOLD is where an exact raw window becomes affordable.
export const BUCKET = 64;
export const RAW_THRESHOLD = 200_000;

/** Min/max envelope of every channel at BUCKET-sample resolution. */
export function buildPeaks(chs, fs) {
  const n = chs[0].length;
  const nb = Math.ceil(n / BUCKET);
  const xs = new Float64Array(nb * 2);
  for (let b = 0; b < nb; b++) {
    const s = b * BUCKET;
    // Anchor to the bucket edges rather than the true peak times: it keeps x
    // strictly increasing, and at the zoom levels where peaks are used a whole
    // bucket is sub-pixel anyway.
    xs[2 * b] = s / fs;
    xs[2 * b + 1] = (Math.min(s + BUCKET, n) - 1) / fs;
  }
  return [xs, ...chs.map((y) => envelope(y, nb))];
}

/**
 * Two points per bucket, ordered so the extreme that occurred first is emitted
 * first — the line then traces the waveform's outline rather than zigzagging
 * against the direction of time.
 */
function envelope(y, nb) {
  const out = new Float64Array(nb * 2);
  const n = y.length;
  for (let b = 0; b < nb; b++) {
    const s = b * BUCKET;
    const e = Math.min(s + BUCKET, n);
    let mn = y[s];
    let mx = y[s];
    let mnAt = s;
    let mxAt = s;
    for (let i = s + 1; i < e; i++) {
      const v = y[i];
      if (v < mn) {
        mn = v;
        mnAt = i;
      } else if (v > mx) {
        mx = v;
        mxAt = i;
      }
    }
    const minFirst = mnAt <= mxAt;
    out[2 * b] = minFirst ? mn : mx;
    out[2 * b + 1] = minFirst ? mx : mn;
  }
  return out;
}

/**
 * Exact samples covering the time window [x0, x1], for every channel.
 * Used once zoomed in far enough that the raw window is small.
 */
export function rawSlice(chs, fs, x0, x1) {
  const i0 = Math.max(0, Math.floor(x0 * fs));
  const i1 = Math.min(chs[0].length, Math.ceil(x1 * fs) + 1); // inclusive of x1
  const n = Math.max(0, i1 - i0);
  const xs = new Float64Array(n);
  for (let i = 0; i < n; i++) xs[i] = (i0 + i) / fs;
  return [xs, ...chs.map((y) => y.subarray(i0, i0 + n))];
}

/**
 * Exact [min, max] across every channel of a buildPeaks() result. Exact because
 * the envelope already contains each bucket's extremes, so this never has to
 * touch the raw samples. Used to pin the y scale so it can't rescale on pan.
 */
export function extent(data) {
  let mn = Infinity;
  let mx = -Infinity;
  for (let s = 1; s < data.length; s++) {
    const a = data[s];
    for (let i = 0; i < a.length; i++) {
      if (a[i] < mn) mn = a[i];
      if (a[i] > mx) mx = a[i];
    }
  }
  if (mn > mx) return [-1, 1]; // empty signal
  const pad = (mx - mn) * 0.05 || 1;
  return [mn - pad, mx + pad];
}
