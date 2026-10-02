// Short-time spectra for the spectrogram view.
//
// No DSP is implemented here beyond a window function: subnerodsp already
// ships a SciPy/SignalAnalysis.jl-validated STFT. Its `db` mode is already
// dB FS — scaleInto() computes 20*log10(|X| * 2 / windowSum), and a windowed
// full-scale sinusoid has |X| = A*windowSum/2, so the peak bin reads
// 20*log10(A): 0 dB at full scale, window gain already divided out.
//
// Defaults match SignalAnalysis.jl's specgram recipe (ext/PlotsExt.jl).

import { SpectrogramStream } from 'subnerodsp';

export const NFFT = 256;
export const NOVERLAP = NFFT / 2;
export const CRANGE = 50; // dB shown below the loudest bin

/**
 * Symmetric Hamming window, matching DSP.jl's hamming() — SignalAnalysis.jl's
 * specgram default. subnerodsp only builds Hann, but takes any window array.
 */
export function hamming(n) {
  const w = new Float64Array(n);
  for (let i = 0; i < n; i++) w[i] = 0.54 - 0.46 * Math.cos((2 * Math.PI * i) / (n - 1));
  return w;
}

const HAMMING_NFFT = hamming(NFFT);

/**
 * dB FS spectrogram of ch[i0, i1), max-pooled down to at most maxCols columns.
 *
 * Returns null when the range holds less than two segments — at that zoom a
 * 256-point transform has nothing to say, and the caller shows an empty pane
 * instead. That one rule also covers signals shorter than two segments, so nfft
 * is fixed at NFFT everywhere and the frequency axis never changes meaning.
 *
 * `db` is column-major: column c, bin b is db[c * bins + b].
 */
export function buildSpecgram(ch, fs, i0, i1, maxCols) {
  i0 = Math.max(0, Math.floor(i0));
  i1 = Math.min(ch.length, Math.ceil(i1));
  const n = i1 - i0;
  if (n < 2 * NFFT || maxCols < 1) return null;

  const stream = new SpectrogramStream({
    fs,
    nperseg: NFFT,
    noverlap: NOVERLAP,
    window: HAMMING_NFFT,
    mode: 'db'
  });
  const { hop, numBins: bins, frequencies } = stream;

  // The stream's overlap history starts zeroed, so the first NFFT/hop - 1
  // columns are part silence. Prime past them rather than plotting them.
  const priming = NFFT / hop - 1;
  const rawCols = Math.floor(n / hop) - priming;
  if (rawCols < 1) return null;

  // Max-pool rather than mean: max in dB is the dB of the max power, so pooling
  // in the dB domain is exact with no power round-trip, and a short transient
  // survives instead of being averaged into the noise floor. SignalAnalysis.jl
  // offers the same as pooling=:max.
  // ponytail: max-pool only; add :mean if averaged displays are ever wanted
  const pool = Math.ceil(rawCols / maxCols);
  const cols = Math.ceil(rawCols / pool);

  const db = new Float32Array(cols * bins).fill(-Infinity);
  const col = new Float64Array(bins);
  let at = i0;
  for (let k = 0; k < priming; k++, at += hop) stream.process(ch.subarray(at, at + hop), col);

  for (let c = 0; c < rawCols; c++, at += hop) {
    stream.process(ch.subarray(at, at + hop), col);
    const o = Math.floor(c / pool) * bins;
    for (let b = 0; b < bins; b++) {
      if (col[b] > db[o + b]) db[o + b] = col[b];
    }
  }

  // Time of the first column's centre, and the spacing between pooled columns.
  const t0 = (i0 + priming * hop + NFFT / 2) / fs;
  return { db, cols, bins, frequencies, t0, dt: (pool * hop) / fs };
}

/**
 * Colour limits, following SignalAnalysis.jl: snap to a 5 dB grid and show at
 * most `crange` dB below the peak, so a quiet noise floor can't wash the plot out.
 */
export function dbLimits(db, crange = CRANGE) {
  let mn = Infinity;
  let mx = -Infinity;
  for (let i = 0; i < db.length; i++) {
    const v = db[i];
    if (!Number.isFinite(v)) continue;
    if (v < mn) mn = v;
    if (v > mx) mx = v;
  }
  if (mn > mx) return [-crange, 0]; // nothing finite to scale against
  const cmax = Math.ceil(mx / 5) * 5 + 0; // +0 so a peak just under 0 dB isn't labelled "-0"
  return [Math.max(cmax - crange, Math.floor(mn / 5) * 5), cmax];
}

// Viridis, sampled at 9 stops and interpolated to a 256-entry RGB table. It is
// perceptually uniform and stays readable in greyscale, which matters when
// these plots end up in a report.
export const VIRIDIS = (() => {
  const stops = [
    [68, 1, 84], [72, 40, 120], [62, 74, 137], [49, 104, 142], [38, 130, 142],
    [31, 158, 137], [53, 183, 121], [110, 206, 88], [253, 231, 37]
  ];
  const lut = new Uint8ClampedArray(256 * 3);
  for (let i = 0; i < 256; i++) {
    const p = (i / 255) * (stops.length - 1);
    const j = Math.min(Math.floor(p), stops.length - 2);
    const f = p - j;
    for (let k = 0; k < 3; k++) lut[i * 3 + k] = stops[j][k] + f * (stops[j + 1][k] - stops[j][k]);
  }
  return lut;
})();
