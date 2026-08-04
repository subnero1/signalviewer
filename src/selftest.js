// Self-check for the pure modules: node src/selftest.js
// Synthesises files in memory and asserts round-trips. No framework by design.

import assert from 'node:assert/strict';
import { parseSignals, readSignal, parseRecording } from './parse.js';
import { buildPeaks, rawSlice, extent, BUCKET } from './peaks.js';
import { toPassband, passbandSps } from './passband.js';

const close = (a, b, tol = 1e-5) =>
  assert.ok(Math.abs(a - b) < tol, `expected ${b}, got ${a}`);

function b64(bytes) {
  let s = '';
  for (const byte of bytes) s += String.fromCharCode(byte);
  return btoa(s);
}

// --- signals-*.txt, complex baseband ----------------------------------------
{
  // 2 channels x 3 samples, laid out as Julia's (channels, samples) column-major:
  // element (sample s, channel c) sits at index c + channels*s.
  // Each channel sums to zero so DC removal is a no-op and magnitudes are exact.
  const iq = [
    [3, 4], [1, 0],   // s0: ch0, ch1
    [-3, -4], [-1, 0], // s1
    [0, 0], [0, 0]     // s2
  ];
  const buf = new DataView(new ArrayBuffer(iq.length * 8));
  iq.forEach(([re, im], i) => {
    buf.setFloat32(i * 8, re, false); // big-endian, matching Julia's ntoh
    buf.setFloat32(i * 8 + 4, im, false);
  });

  const text = [
    'some unrelated log line',
    '1700000000000|RxBasebandSignalNtf:INFORM[fc:24000.0 fs:12000.0 rssi:-30.5 channels:2 (3 samples)]',
    b64(new Uint8Array(buf.buffer)),
    'another unrelated line'
  ].join('\n');

  const parsed = parseSignals(text);
  assert.equal(parsed.index.length, 1);
  const e = parsed.index[0];
  assert.equal(e.fs, 12000);
  assert.equal(e.fc, 24000);
  assert.equal(e.channels, 2);
  assert.equal(e.len, 3);
  assert.equal(e.rssi, -30.5);
  assert.equal(e.dataLine, 2, 'payload is on the line after the header');

  const sig = readSignal(parsed, 0);
  assert.equal(sig.complex, true);
  assert.equal(sig.ch.length, 2);
  assert.equal(sig.fs, 12000);
  assert.equal(sig.fc, 24000);
  // Interleaved I/Q, not magnitude — the carrier has to survive parsing so it
  // can be upconverted later.
  assert.equal(sig.ch[0].length, 6, 'complex channel is 2 floats per sample');
  [3, 4, -3, -4, 0, 0].forEach((v, i) => close(sig.ch[0][i], v));
  [1, 0, -1, 0, 0, 0].forEach((v, i) => close(sig.ch[1][i], v));
}

// --- signals-*.txt, real baseband (fc == 0) ---------------------------------
{
  const vals = [1, 2, 3, 4]; // mean 2.5 is removed on load
  const buf = new DataView(new ArrayBuffer(vals.length * 4));
  vals.forEach((v, i) => buf.setFloat32(i * 4, v, false));
  // Field order and wording copied from a real signals-*.txt: no channels
  // field, and "baseband samples" rather than plain "samples".
  const text = [
    '1778228149118|RxBasebandSignalNtf:INFORM[rxStartTime:2585456782 rssi:-85.8 preamble:1 fc:0.0 fs:8000.0 (4 baseband samples)]',
    b64(new Uint8Array(buf.buffer))
  ].join('\n');

  const parsed = parseSignals(text);
  assert.equal(parsed.index[0].channels, 1, 'channels defaults to 1');
  assert.equal(parsed.index[0].preamble, 1);
  assert.equal(parsed.index[0].rxtime, 2585456782);
  assert.equal(parsed.index[0].len, 4);
  const sig = readSignal(parsed, 0);
  assert.equal(sig.complex, false);
  [-1.5, -0.5, 0.5, 1.5].forEach((v, i) => close(sig.ch[0][i], v));
}

// --- rec-*.dat with a header ------------------------------------------------
{
  const samples = [1, 0, 2, 0, 3, 0, 4, 0]; // 2ch interleaved: ch0=1..4, ch1=0
  const buf = new ArrayBuffer(32 + samples.length * 4);
  const dv = new DataView(buf);
  dv.setBigUint64(0, 0x43c04d126f173001n, true);
  dv.setBigInt64(8, 1700000000000n, true);
  dv.setInt32(16, 8000, true);
  dv.setInt16(20, 2, true);
  samples.forEach((v, i) => dv.setFloat32(32 + i * 4, v, true));

  const sig = parseRecording(buf);
  assert.equal(sig.fs, 8000);
  assert.equal(sig.ch.length, 2);
  assert.equal(sig.t0, 1700000000000);
  assert.equal(sig.ch[0].length, 4);
  [-1.5, -0.5, 0.5, 1.5].forEach((v, i) => close(sig.ch[0][i], v));
  sig.ch[1].forEach((v) => close(v, 0));
}

// --- rec-*.dat written big-endian (what real UnetStack recordings are) ------
{
  const samples = [1, 0, 2, 0, 3, 0, 4, 0];
  const buf = new ArrayBuffer(32 + samples.length * 4);
  const dv = new DataView(buf);
  dv.setBigUint64(0, 0x43c04d126f173001n, false);
  dv.setBigInt64(8, 1785741309037n, false);
  dv.setInt32(16, 96000, false);
  dv.setInt16(20, 2, false);
  samples.forEach((v, i) => dv.setFloat32(32 + i * 4, v, false));

  const sig = parseRecording(buf);
  assert.equal(sig.fs, 96000, 'endianness probed from the magic governs the whole header');
  assert.equal(sig.ch.length, 2);
  assert.equal(sig.t0, 1785741309037);
  [-1.5, -0.5, 0.5, 1.5].forEach((v, i) => close(sig.ch[0][i], v));
  sig.ch[1].forEach((v) => close(v, 0));
}

// --- rec-*.dat with no header falls back to 32kHz / 4ch ---------------------
{
  const buf = new ArrayBuffer(8 * 4);
  const dv = new DataView(buf);
  for (let i = 0; i < 8; i++) dv.setFloat32(i * 4, i, true);
  const sig = parseRecording(buf);
  assert.equal(sig.fs, 32000);
  assert.equal(sig.ch.length, 4);
  assert.equal(sig.ch[0].length, 2, 'body starts at offset 0 when the magic is absent');
}

// --- buildPeaks must not lose transients, across every channel --------------
{
  const n = 1000;
  const fs = 1000;
  const a = new Float32Array(n); // flat, except two single-sample excursions
  a[500] = 7;
  a[123] = -5;
  const b = new Float32Array(n);
  b[900] = 3; // a transient only the second channel has
  const [xs, ya, yb] = buildPeaks([a, b], fs);

  assert.equal(ya.length, 2 * Math.ceil(n / BUCKET));
  assert.equal(xs.length, ya.length, 'all channels share one x array');
  assert.equal(yb.length, ya.length);
  assert.ok([...ya].includes(7), 'positive spike survived decimation');
  assert.ok([...ya].includes(-5), 'negative spike survived decimation');
  assert.ok([...yb].includes(3), 'second channel decimated independently');
  assert.ok(![...yb].includes(7), 'channels are not cross-contaminated');

  // uPlot binary-searches x, so it must never go backwards.
  for (let i = 1; i < xs.length; i++) assert.ok(xs[i] >= xs[i - 1], `x regressed at ${i}`);
  close(xs[0], 0);
  close(xs[1], (BUCKET - 1) / fs);
  assert.ok(xs[xs.length - 1] <= (n - 1) / fs, 'peaks never extend past the signal');

  // The y scale is pinned to this, so it must span every channel's extremes.
  const [lo, hi] = extent([xs, ya, yb]);
  assert.ok(lo < -5 && hi > 7, `extent ${lo}..${hi} covers all channels with padding`);
}

// --- rawSlice covers the requested window, and clamps at the ends -----------
{
  const fs = 100;
  const y = Float32Array.from({ length: 100 }, (_, i) => i);

  const [xs, ys] = rawSlice([y], fs, 0.1, 0.2);
  assert.equal(xs.length, ys.length);
  assert.ok(xs[0] <= 0.1, 'window starts at or before x0');
  assert.ok(xs[xs.length - 1] >= 0.2, 'window ends at or after x1');
  close(ys[0], Math.round(xs[0] * fs));

  const [full] = rawSlice([y], fs, -5, 500);
  assert.equal(full.length, 100, 'clamped to the available samples');
  assert.equal(rawSlice([y], fs, 50, 60)[0].length, 0, 'window past the end is empty');
  assert.equal(rawSlice([y, y], fs, 0.1, 0.2).length, 3, 'returns [x, ...channels]');
}

// --- baseband -> passband upconversion --------------------------------------
{
  // Real signals must pass straight through, untouched and un-copied.
  const real = { complex: false, fs: 8000, ch: [Float32Array.from([1, 2, 3])] };
  assert.equal(toPassband(real), real, 'a real signal is returned as-is');

  // The fc -> passband combinations actually in use. Baseband dumps arrive at
  // fs == fc, so every one of these is a x4 interpolation.
  for (const [fc, want] of [
    [12000, 48000],
    [24000, 96000], // matches the 96 kHz rec-*.dat recordings
    [40000, 160000],
    [64000, 256000]
  ]) {
    const sps = passbandSps(fc, fc);
    assert.equal(sps, 4, `fc ${fc} is a x4 interpolation`);
    assert.equal(sps * fc, want, `fc ${fc} Hz upconverts to ${want} Hz`);
    assert.ok(sps * fc > 2 * fc + fc, `fc ${fc} clears Nyquist`);
  }

  // Refuse rather than alias: a baseband rate above 2*fc can't fit under a 4x
  // passband, and a silently aliased plot would be worse than an error.
  assert.throws(() => passbandSps(24000, 96000), /aliasing/, 'fs > 2*fc is rejected');
  assert.throws(() => passbandSps(0, 24000), /not a baseband signal/);

  // Constant baseband (I=1, Q=0) upconverts to a pure tone at fc.
  const n = 2048;
  const fs = 24000;
  const fc = 24000;
  const iq = new Float32Array(n * 2);
  for (let s = 0; s < n; s++) iq[2 * s] = 1;

  const out = toPassband({ complex: true, fc, fs, t0: 0, ch: [iq] });
  const y = out.ch[0];
  const sps = passbandSps(fc, fs);

  assert.equal(out.complex, false, 'result is a real signal');
  assert.equal(out.fs, fs * sps, 'sample rate scales with sps');
  // upconvert returns (n + 2*RRCOS_PAD)*sps; the padding must be trimmed back
  // off or every plotted signal is shifted late by RRCOS_PAD baseband samples.
  assert.equal(y.length, n * sps, 'filter transient trimmed, duration preserved');
  close(y.length / out.fs, n / fs, 1e-9); // same wall-clock duration as the source
  assert.ok(y.every(Number.isFinite), 'no NaNs');

  // Energy must sit at fc, not at DC or some image.
  const power = (f) => {
    let re = 0;
    let im = 0;
    for (let i = 0; i < y.length; i++) {
      const p = (2 * Math.PI * f * i) / out.fs;
      re += y[i] * Math.cos(p);
      im += y[i] * Math.sin(p);
    }
    return Math.hypot(re, im) / y.length;
  };
  const atFc = power(fc);
  assert.ok(atFc > 0.1, `carrier present at fc (got ${atFc.toFixed(4)})`);
  assert.ok(atFc > 20 * power(fc / 2), 'energy is at fc, not spread');
  assert.ok(atFc > 20 * power(0), 'not left at DC — it really was upconverted');
}

console.log('ok');
