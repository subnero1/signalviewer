// Baseband -> passband conversion, applied before plotting.
//
// A baseband dump (fc != 0) is not just complex, it has been spectrally shifted
// down to DC. Plotting |x| would show only the envelope and throw the carrier
// away, so what actually gets plotted is the real passband signal the modem
// heard, recovered with subnerodsp's upconvert().
//
// This lives outside the viewer component on purpose: the component plots real
// signals and knows nothing about modulation.

import { upconvert } from 'subnerodsp';

// upconvert() pulse-shapes with rrcosfir(0.25, sps). At beta = 0.25 that filter
// spans 22 baseband samples, so upconvert pads the input with 11 samples of
// transient on each side and returns (n + 22) * sps samples. Trimming that
// padding back off is what keeps plot time t=0 on the first recorded sample.
export const RRCOS_PAD = 11;

/**
 * Passband sample rate as a multiple of the carrier.
 *
 * Subnero modems run passband at 4x the carrier frequency. The combinations in
 * regular use:
 *
 *   fc  12 kHz -> passband  48 kHz
 *   fc  24 kHz -> passband  96 kHz   (matches the rec-*.dat recordings)
 *   fc  40 kHz -> passband 160 kHz
 *   fc  64 kHz -> passband 256 kHz
 *
 * An 8x mode exists but is rare, and is deliberately not supported: it would
 * double the plotted sample count for no extra information. If an 8x capture
 * ever needs viewing, change this constant rather than special-casing it.
 */
export const PASSBAND_MULTIPLE = 4;

/**
 * Passband samples per baseband sample — the interpolation factor that takes a
 * baseband dump at `fs` up to a passband rate of PASSBAND_MULTIPLE*fc. Baseband
 * dumps arrive at fs == fc in practice, so this is 4.
 */
export function passbandSps(fc, fs) {
  if (!(fs > 0)) throw new Error(`bad sampling rate: ${fs}`);
  if (!(fc > 0)) throw new Error(`not a baseband signal: fc = ${fc}`);

  const sps = Math.round((PASSBAND_MULTIPLE * fc) / fs);
  if (sps < 1) {
    throw new Error(`baseband fs ${fs} Hz is too high for a ${PASSBAND_MULTIPLE}x passband at fc ${fc} Hz`);
  }
  // The upconverted signal occupies fc ± fs/2, so sps*fs must clear 2*fc + fs.
  // At 4x this holds whenever fs <= 2*fc, which every real configuration
  // satisfies — but a capture that broke it would alias, and a silently
  // aliased plot is worse than a refused one.
  if (sps * fs < 2 * fc + fs) {
    throw new Error(
      `fc ${fc} Hz with baseband fs ${fs} Hz needs more than ${PASSBAND_MULTIPLE}x oversampling to avoid aliasing`
    );
  }
  return sps;
}

/**
 * Upconvert a parsed baseband signal to a real passband one.
 *
 * Real signals (a recording, or a dump with fc == 0) are returned untouched,
 * so this is safe to apply to anything the parsers produce.
 */
export function toPassband(sig) {
  if (!sig.complex) return sig;

  const { fc, fs } = sig;
  const sps = passbandSps(fc, fs);
  const trim = sps > 1 ? RRCOS_PAD * sps : 0;

  const ch = sig.ch.map((iq) => {
    const n = (iq.length / 2) * sps; // one baseband sample becomes sps passband ones
    const pb = upconvert(iq, { sps, fc, fs });
    // Back to Float32: the rest of the pipeline is Float32, and a passband
    // signal is sps times longer than the baseband it came from.
    return Float32Array.from(pb.subarray(trim, trim + n));
  });

  const fsOut = fs * sps;
  return {
    ...sig,
    ch,
    fs: fsOut,
    complex: false,
    source: { fc, fs, sps }, // what it was before conversion, for the UI
    label: `${new Date(sig.t0).toISOString()} · passband fc ${hz(fc)} · fs ${hz(fsOut)} · ${ch[0].length.toLocaleString()} samples`
  };
}

function hz(v) {
  return v >= 1000 ? `${+(v / 1000).toFixed(3)} kHz` : `${v} Hz`;
}
