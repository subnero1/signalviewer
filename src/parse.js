// Parsers for the two UnetStack signal file formats, per UnetUtils.jl
// (src/signals.jl and src/recordings.jl).
//
// Both produce the same normalized shape:
//
//   { ch: [Float32Array, ...], fs, fc, t0, label, complex }
//
// Channel arrays are DC-removed. When `complex` is false they hold real
// samples. When it is true (a baseband dump with fc != 0) they hold
// **interleaved I/Q** — [I0, Q0, I1, Q1, ...], twice as long as the sample
// count — which is the layout subnerotools' upconvert() expects.
//
// These parsers deliberately do no DSP: a baseband signal is spectrally
// shifted, so turning it into something plottable is an upconversion, and that
// belongs to the caller (see toPassband in App.vue), not to file parsing.

const SIGNAL_RE = /^(\d+)\|RxBasebandSignalNtf:INFORM\[(.*) \((\d+) .*samples\)\]/;

// rec-*.dat header, 32 bytes total.
const MAGIC = 0x43c04d126f173001n;
const HEADER_BYTES = 32;
const DEFAULT_FS = 32000; // FRAMERATE in recordings.jl, used when there is no header
const DEFAULT_CHANNELS = 4; // NCHANNELS ditto

/**
 * Index every RxBasebandSignalNtf in a signals-*.txt dump.
 *
 * Returns the split lines alongside the index so readSignal() doesn't have to
 * re-split a potentially large file for every selection.
 */
export function parseSignals(text) {
  const lines = text.split('\n');
  const index = [];
  lines.forEach((line, i) => {
    const m = SIGNAL_RE.exec(line);
    if (!m) return;
    const params = Object.fromEntries(
      m[2].split(' ').filter(Boolean).map((p) => {
        const at = p.indexOf(':');
        return [p.slice(0, at), p.slice(at + 1)];
      })
    );
    index.push({
      time: Number(m[1]),
      len: Number(m[3]),
      fc: Number(params.fc),
      fs: Number(params.fs),
      channels: Number(params.channels ?? 1),
      preamble: Number(params.preamble ?? 0),
      rssi: 'rssi' in params ? Number(params.rssi) : null,
      rxtime: Number(params.rxStartTime ?? params.rxTime ?? NaN),
      dataLine: i + 1 // payload is on the line after the header
    });
  });
  return { lines, index };
}

/** Decode the i'th signal of a parseSignals() result into normalized form. */
export function readSignal({ lines, index }, i) {
  const e = index[i];
  if (!e) throw new Error(`no signal at index ${i}`);
  const payload = lines[e.dataLine];
  if (payload == null) throw new Error(`signal ${i}: payload line is missing`);

  const bytes = base64Bytes(payload.trim());
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const complex = e.fc !== 0;
  const stride = complex ? 2 : 1; // floats per sample
  const want = e.len * e.channels * stride * 4;
  if (dv.byteLength < want) {
    throw new Error(`signal ${i}: expected ${want} bytes of payload, got ${dv.byteLength}`);
  }

  // Julia reshapes to (channels, samples) column-major, so a sample's channels
  // sit next to each other: element (sample s, channel c) is at c + channels*s.
  const ch = [];
  for (let c = 0; c < e.channels; c++) {
    if (complex) {
      // Interleaved I/Q, DC removed on each component independently — the same
      // complex-mean subtraction UnetUtils applies.
      const out = new Float32Array(e.len * 2);
      for (let s = 0; s < e.len; s++) {
        const o = (c + e.channels * s) * 8; // ComplexF32 == 8 bytes
        out[2 * s] = dv.getFloat32(o, false); // ntoh: payload is big-endian
        out[2 * s + 1] = dv.getFloat32(o + 4, false);
      }
      const mre = meanStrided(out, 0);
      const mim = meanStrided(out, 1);
      for (let s = 0; s < e.len; s++) {
        out[2 * s] -= mre;
        out[2 * s + 1] -= mim;
      }
      ch.push(out);
    } else {
      const out = new Float32Array(e.len);
      for (let s = 0; s < e.len; s++) out[s] = dv.getFloat32((c + e.channels * s) * 4, false);
      subtract(out, mean(out));
      ch.push(out);
    }
  }

  return {
    ch,
    fs: e.fs,
    fc: e.fc,
    t0: e.time,
    complex,
    label: `${new Date(e.time).toISOString()} · fc ${e.fc} Hz · fs ${e.fs} Hz · ${e.len} samples`
  };
}

/** Decode a passband rec-*.dat recording into normalized form. */
export function parseRecording(buffer) {
  const dv = new DataView(buffer);

  // The magic is a fixed 8-byte signature — real recordings carry it as
  // 43 c0 4d 12 6f 17 30 01, the big-endian rendering of MAGIC — but every
  // field after it, and the sample body, is little-endian. Verified against
  // UnetStack recordings: reading the body big-endian yields denormal garbage
  // around 1e-37. Accept either orientation of the signature itself so a
  // differently-built writer is still recognised.
  const hasHeader =
    dv.byteLength >= HEADER_BYTES &&
    (dv.getBigUint64(0, false) === MAGIC || dv.getBigUint64(0, true) === MAGIC);

  let le = true;
  let fs = hasHeader ? dv.getInt32(16, le) : DEFAULT_FS;
  let channels = hasHeader ? dv.getInt16(20, le) : DEFAULT_CHANNELS;
  // Calibration fallback: if little-endian gives an implausible rate or channel
  // count, the file came from a big-endian writer — retry rather than throw.
  if (hasHeader && !plausible(fs, channels)) {
    le = false;
    fs = dv.getInt32(16, le);
    channels = dv.getInt16(20, le);
  }
  const t0 = hasHeader ? Number(dv.getBigInt64(8, le)) : null;
  const start = hasHeader ? HEADER_BYTES : 0;
  if (!plausible(fs, channels)) throw new Error(`bad header: fs=${fs} channels=${channels}`);

  const total = Math.floor((dv.byteLength - start) / 4);
  const len = Math.floor(total / channels);

  // Normal case is a zero-copy view. On the big-endian fallback the byteswap is
  // folded into the de-interleave, so no swapped copy of the body is made.
  const flat = le ? new Float32Array(buffer, start, total) : null;
  const ch = [];
  for (let c = 0; c < channels; c++) {
    const out = new Float32Array(len);
    if (flat) for (let s = 0; s < len; s++) out[s] = flat[c + channels * s];
    else for (let s = 0; s < len; s++) out[s] = dv.getFloat32(start + (c + channels * s) * 4, false);
    subtract(out, mean(out));
    ch.push(out);
  }

  return {
    ch,
    fs,
    t0,
    complex: false,
    label: `${stamp(t0)}fs ${fs} Hz · ${channels} ch · ${(len / fs).toFixed(3)} s`
  };
}

// Sanity bounds for the header, and the knob that picks its byte order.
// UnetStack tops out well below 2 MSps; widen if that ever changes.
function plausible(fs, channels) {
  return fs > 0 && fs <= 2e6 && channels > 0 && channels <= 64;
}

function stamp(ms) {
  if (!ms || !Number.isFinite(ms) || Math.abs(ms) > 8.64e15) return '';
  return new Date(ms).toISOString() + ' · ';
}

function base64Bytes(s) {
  const bin = atob(s);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

// Accumulate in a double so long signals don't lose the mean to Float32 drift.
function mean(a) {
  let sum = 0;
  for (let i = 0; i < a.length; i++) sum += a[i];
  return a.length ? sum / a.length : 0;
}

/** Mean of every other element, for one component of an interleaved pair. */
function meanStrided(a, offset) {
  let sum = 0;
  let n = 0;
  for (let i = offset; i < a.length; i += 2, n++) sum += a[i];
  return n ? sum / n : 0;
}

function subtract(a, v) {
  for (let i = 0; i < a.length; i++) a[i] -= v;
}
