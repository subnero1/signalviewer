# Signal Viewer

A Vue 3 component for plotting UnetStack signals — baseband dumps
(`signals-*.txt`) and passband recordings (`rec-*.dat`) — built on
[uPlot](https://github.com/leeoniya/uPlot). Zooms and pans smoothly on captures
of tens of millions of samples.

This repo is both the component and a small app that exercises it.

## Running the app

```sh
pnpm install
pnpm dev
```

Then open the printed URL and pick a `rec-*.dat` or `signals-*.txt`, or drop one
anywhere on the window.

| Script              | What it does                                                                                       |
|---------------------|----------------------------------------------------------------------------------------------------|
| `pnpm dev`          | Dev server with HMR                                                                                |
| `pnpm build` | **Single self-contained `build/index.html`** — no CDN, no separate assets, opens straight off disk |
| `pnpm test`         | Assertion self-check for the parsing and DSP modules (`node`, no framework)                        |

`build` uses [vite-plugin-singlefile](https://github.com/richardtallent/vite-plugin-singlefile) which generates a single `index.html` with all JS/CSS inlined. Great for sharing a capture with someone else, or for embedding the component in a static site.

## Using the component elsewhere

The component is self-contained: it needs **`vue` and `uplot`** and one local
module, `peaks.js`. It does not depend on the parsers or on `subnerodsp`.

### Option A — copy it in (simplest)

```sh
pnpm add uplot
```

Copy `src/SignalViewer.vue` and `src/peaks.js` (they must sit next to each
other, the component imports `./peaks.js`), then:

```vue
<script setup>
import SignalViewer from './components/SignalViewer.vue';

const fs = 8000;
const y = Float32Array.from({ length: 4000 }, (_, i) => Math.sin((2 * Math.PI * 400 * i) / fs));
const signal = { ch: [y], fs, label: '400 Hz tone' };
</script>

<template>
  <SignalViewer :signal="signal" title="demo" />
</template>
```

### Option B — install from git

```sh
pnpm add github:subnero1/signalviewer
```

```js
import SignalViewer from 'signalviewer/src/SignalViewer.vue';
```

Your build needs `@vitejs/plugin-vue` (or equivalent) since this imports a raw
`.vue` file. Import the subpath — `package.json` has no `exports` map, so a bare
`import 'signalviewer'` will not resolve.

**This package depends on `subnerodsp` via git, and pnpm rejects git
sub-dependencies by default.** The install fails with `ERR_PNPM_EXOTIC_SUBDEP`
unless the consuming project opts in, in `pnpm-workspace.yaml` (the `.npmrc`
equivalent is *not* honoured):

```yaml
blockExoticSubdeps: false
```

Only `passband.js` needs `subnerodsp`. If you just want the chart, Option A
avoids this entirely.

## Component API

### Props

| Prop           | Type      | Default    | Notes                                                 |
|----------------|-----------|------------|-------------------------------------------------------|
| `signal`       | `Object`  | *required* | See below                                             |
| `title`        | `String`  | `''`       | Rendered above the plot; the app passes the file name |
| `ranger`       | `Boolean` | `true`     | Show the overview strip above the chart               |
| `height`       | `Number`  | `300`      | Main chart height, px                                 |
| `rangerHeight` | `Number`  | `90`       | Overview height, px                                   |

### The `signal` object

```js
{
  ch: [Float32Array, ...],  // one entry per channel, all the same length
  fs,                       // sample rate, Hz
  label                     // string shown in the status bar
}
```

**Channels must be real-valued.** The component plots real samples only; complex
baseband is converted before it gets here (see below). Channels share one time
axis, so they must be equal length. Amplitude is not rescaled per view — the y
range is pinned to the whole signal's extent so amplitudes stay comparable as
you pan.

### Exposed

```js
viewerRef.value.reset(); // zoom back out to the full signal
```

### Interactions

Drag to zoom · wheel to zoom · shift-drag to pan · double-click to reset · drag
the overview to jump · click a channel in the legend to hide it.

## Loading UnetStack files

The parsers are independent of the component — plain functions over typed
arrays, no Vue, no DOM, which is why `pnpm test` can run them under bare `node`.

```js
import { parseSignals, readSignal, parseRecording } from './parse.js';
import { toPassband } from './passband.js';

// rec-*.dat — one signal, several channels, already real
const rec = toPassband(parseRecording(await file.arrayBuffer()));

// signals-*.txt — many signals; index them, then read one
const dump = parseSignals(await file.text());   // { lines, index }
const sig = toPassband(readSignal(dump, 0));    // dump.index[i] has fc, fs, len, rssi, time
```

`toPassband` is a no-op on real signals, so it is safe to apply to anything the
parsers return.

### Why `toPassband` is needed

A baseband dump with `fc != 0` is complex **and** spectrally shifted down to DC.
Plotting its magnitude would show only the envelope and throw the carrier away.
`toPassband` upconverts it back to the real passband signal the modem heard,
using `upconvert()` from `subnerodsp`.

Subnero modems run passband at **4× the carrier**, which is the rate used here:

| `fc`   | passband |
|--------|----------|
| 12 kHz | 48 kHz   |
| 24 kHz | 96 kHz   |
| 40 kHz | 160 kHz  |
| 64 kHz | 256 kHz  |

The rarer 8× mode is deliberately unsupported; it is a one-constant change
(`PASSBAND_MULTIPLE` in `src/passband.js`) rather than a special case.

## How it stays fast

uPlot's `linear()` path builder already collapses dense data to per-pixel
min/max, so transients survive without aliasing. What it cannot do is avoid one
x value per sample — 15 M samples would mean a 120 MB `Float64Array` — or avoid
walking every point in range.

So `peaks.js` does one O(n) pass on load, building a min/max envelope over
64-sample buckets, and hands uPlot that array unchanged on every redraw. Below a
200 000-sample window it swaps to exact samples. Both thresholds are named
exports (`BUCKET`, `RAW_THRESHOLD`) — tuning knobs, not constants.

Measured on a 38 s × 4-channel 96 kHz recording: ~90 ms to parse, and frames
inside the 60 fps budget while wheel-zooming.

## Layout

| Path                   | Purpose                                            |
|------------------------|----------------------------------------------------|
| `src/SignalViewer.vue` | The component. uPlot instances, zoom/pan, overview |
| `src/peaks.js`         | Envelope + raw-window builders. Pure               |
| `src/parse.js`         | `signals-*.txt` and `rec-*.dat` readers. Pure      |
| `src/passband.js`      | Baseband → passband upconversion. Pure             |
| `src/App.vue`          | Demo app: file picking, signal selection, states   |
| `src/selftest.js`      | `node src/selftest.js`                             |

## File formats

Verified against [UnetUtils.jl](https://github.com/org-arl/UnetUtils.jl) and
real captures.

**`signals-*.txt`** — pairs of lines: a header, then base64 on the *next* line.
Payload is big-endian Float32; `fc == 0` means real, `fc != 0` means complex
(interleaved I/Q). Channel-interleaved as `c + channels*s`. Real headers say
`(N baseband samples)` and often omit `channels`.

**`rec-*.dat`** — 32-byte header, then Float32 samples. **The header is
mixed-endian**: the magic `0x43C04D126F173001` is stored big-endian, but
`millis`, `framerate`, `nchannels` and the whole body are little-endian. If the
magic is absent there is no header at all — the body starts at offset 0 and
defaults to 32 kHz / 4 channels.
