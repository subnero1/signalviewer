<script setup>
import { ref, shallowRef, watch, onMounted, onBeforeUnmount } from 'vue';
import uPlot from 'uplot';
import 'uplot/dist/uPlot.min.css';
import { buildSpecgram, dbLimits, VIRIDIS, NFFT } from './specgram.js';
import { Y_SIZE, Y_LABEL, timeDecimals, makeClamp, navPlugin, deferRedraw } from './uplotnav.js';

const props = defineProps({
  // The same real-valued signal the waveform plots: { ch: [Float32Array], fs }.
  signal: { type: Object, required: true },
  channel: { type: Number, default: 0 },
  // Shared x window, two-way. Null until the owner sets it.
  xwin: { type: Object, default: null },
  height: { type: Number, default: 220 }
});
const emit = defineEmits(['update:xwin']);

const el = ref(null);
const plot = shallowRef(null);
const note = ref('');
const limits = ref([-100, 0]);
const barEl = ref(null);

let duration = 0;
// Whole-signal pass, computed once. Zooming out repeatedly must not mean
// re-running an FFT per 128 samples of a 15M-sample file; this is the
// spectrogram's equivalent of peaks.js's envelope.
let wide = null;
// The window the raster currently shows, and the loop guard: the redraw below
// re-enters this path, and an unchanged window means there is nothing to do.
let applied = { min: NaN, max: NaN, w: 0 };
let raster = null; // offscreen canvas holding the painted image

const ch = () => props.signal.ch[props.channel];
const clamp = makeClamp(() => duration, () => props.signal.fs);

// Plot-area width in device pixels — also the column budget. One column per
// device pixel rather than per CSS pixel: the raster is blitted with smoothing
// off, so anything coarser is visibly blocky on a retina display.
const plotWidth = (u) => Math.max(1, Math.round(u.bbox.width));

/**
 * The cached whole-signal pass, cropped to [min, max] — used whenever it still
 * resolves at least one column per pixel there, which is every zoom level down
 * to a fairly deep one. Columns are contiguous and evenly spaced, so this is a
 * subarray, not a recompute.
 */
function fromWide(min, max, w) {
  if (!wide || (max - min) / wide.dt < w) return null;
  const c0 = Math.max(0, Math.floor((min - wide.t0) / wide.dt));
  const c1 = Math.min(wide.cols, Math.ceil((max - wide.t0) / wide.dt) + 1);
  if (c1 - c0 < 1) return null;
  return { ...wide, db: wide.db.subarray(c0 * wide.bins, c1 * wide.bins), cols: c1 - c0 };
}

/** Paint a spectrogram into an offscreen canvas, one pixel per column/bin. */
function paint(spec) {
  const { db, cols, bins } = spec;
  const [cmin, cmax] = limits.value;
  const span = cmax - cmin || 1;
  const img = new ImageData(cols, bins);
  const px = img.data;
  for (let c = 0; c < cols; c++) {
    for (let b = 0; b < bins; b++) {
      // Row 0 of the image is the top of the plot, but bin 0 is DC, which
      // belongs at the bottom.
      const i = ((bins - 1 - b) * cols + c) * 4;
      const t = (db[c * bins + b] - cmin) / span;
      const l = (t <= 0 ? 0 : t >= 1 ? 255 : Math.round(t * 255)) * 3;
      px[i] = VIRIDIS[l];
      px[i + 1] = VIRIDIS[l + 1];
      px[i + 2] = VIRIDIS[l + 2];
      px[i + 3] = 255;
    }
  }
  const cv = raster ?? (raster = document.createElement('canvas'));
  cv.width = cols;
  cv.height = bins;
  cv.getContext('2d').putImageData(img, 0, 0);
}

/** Recompute the raster for the visible window, if it has actually changed. */
function refresh(u) {
  const { min, max } = u.scales.x;
  if (min == null || !wide) return;
  const w = plotWidth(u);
  if (applied.min === min && applied.max === max && applied.w === w) return;
  applied = { min, max, w };

  const fs = props.signal.fs;
  const spec = fromWide(min, max, w) ?? buildSpecgram(ch(), fs, min * fs, max * fs, w);
  if (spec) {
    note.value = '';
    paint(spec);
  } else {
    // Below two segments there is nothing a 256-point transform can say. Say so
    // rather than drawing a handful of meaningless columns stretched to width.
    note.value = `zoomed in past spectral resolution — needs ${2 * NFFT} samples`;
    raster = null;
  }
  u.redraw();
}

const scheduleRefresh = deferRedraw(refresh);

// The raster is the whole chart: uPlot supplies the scales, axes and grid, and
// this paints the image into the plot area. drawClear, not draw — it runs after
// the canvas is cleared but before the axes and gridlines, so those stay on top
// of the raster instead of being buried by it. Rebuilt only when the window
// changes; this hook itself is one drawImage.
const image = {
  hooks: {
    drawClear: (u) => {
      if (!raster) return;
      const { left, top, width, height } = u.bbox;
      const ctx = u.ctx;
      ctx.save();
      ctx.imageSmoothingEnabled = false;
      ctx.drawImage(raster, left, top, width, height);
      ctx.restore();
    }
  }
};

function opts(width) {
  const fs = props.signal.fs;
  const nyquist = fs / 2;
  const kHz = nyquist >= 10000; // matches SignalAnalysis.jl's unit switch
  return {
    width,
    height: props.height,
    plugins: [image, navPlugin({ clamp, onScale: onScale })],
    cursor: { x: false, y: false, points: { show: false }, drag: { x: true, y: false } },
    legend: { show: false },
    scales: {
      x: { time: false },
      // Pinned: panning must never rescale frequency.
      y: { range: () => [0, nyquist] }
    },
    axes: [
      {
        label: 'Time (s)',
        space: 90,
        values: (u, splits) => splits.map((v) => v.toFixed(timeDecimals(u.scales.x)))
      },
      {
        label: `Frequency (${kHz ? 'kHz' : 'Hz'})`,
        size: Y_SIZE,
        labelSize: Y_LABEL,
        grid: { show: false }, // gridlines over a dense raster only add noise
        values: (u, splits) => splits.map((v) => (kHz ? v / 1000 : v))
      }
    ],
    // One stub series so uPlot has a shape to scale against; it draws nothing.
    series: [{}, { paths: () => null, points: { show: false } }]
  };
}

function onScale(u) {
  scheduleRefresh(u);
  const { min, max } = u.scales.x;
  if (min !== props.xwin?.min || max !== props.xwin?.max) emit('update:xwin', { min, max });
}

/** Paint the colour scale strip: the same LUT the raster is drawn through. */
function paintBar() {
  const cv = barEl.value;
  if (!cv) return;
  const { width: w, height: h } = cv;
  const img = new ImageData(w, h);
  for (let x = 0; x < w; x++) {
    const l = Math.round((x / (w - 1)) * 255) * 3;
    for (let y = 0; y < h; y++) {
      const i = (y * w + x) * 4;
      img.data[i] = VIRIDIS[l];
      img.data[i + 1] = VIRIDIS[l + 1];
      img.data[i + 2] = VIRIDIS[l + 2];
      img.data[i + 3] = 255;
    }
  }
  cv.getContext('2d').putImageData(img, 0, 0);
}

function load() {
  const sig = props.signal;
  const y = ch();
  if (!y) return;
  duration = y.length / sig.fs;

  plot.value?.destroy();
  raster = null;
  applied = { min: NaN, max: NaN, w: 0 };

  const width = el.value?.clientWidth || 800;
  // One whole-signal pass at pixel resolution. Its colour limits are then
  // pinned for the life of the signal, so levels stay comparable while panning
  // — the same reasoning that pins the waveform's y range.
  wide = buildSpecgram(y, sig.fs, 0, y.length, width);
  note.value = wide ? '' : `signal is shorter than ${2 * NFFT} samples`;
  if (wide) limits.value = dbLimits(wide.db);

  plot.value = new uPlot(opts(width), [[0, duration], [null, null]], el.value);
  paintBar();
  plot.value.setScale('x', props.xwin ?? { min: 0, max: duration });
}

function resize() {
  const width = el.value?.clientWidth;
  if (!width || !plot.value) return;
  plot.value.setSize({ width, height: props.height });
  // The column budget is the plot width, so a resize invalidates the raster.
  scheduleRefresh(plot.value);
}

let ro;
onMounted(() => {
  load();
  ro = new ResizeObserver(resize);
  ro.observe(el.value);
});

onBeforeUnmount(() => {
  ro?.disconnect();
  plot.value?.destroy();
});

watch(() => [props.signal, props.channel], load);

// Follow the shared window. The inequality is the loop guard: onScale() emits,
// the owner writes it back here, and this stops rather than emitting again.
watch(
  () => props.xwin,
  (w) => {
    const u = plot.value;
    if (!u || !w) return;
    if (u.scales.x.min !== w.min || u.scales.x.max !== w.max) u.setScale('x', w);
  }
);
</script>

<template>
  <div class="specgram">
    <div class="bar">
      <span class="who">
        Spectrogram{{ signal.ch.length > 1 ? ` · ch ${channel}` : '' }}
      </span>
      <span class="scale">
        <span class="lim">{{ limits[0] }}</span>
        <canvas ref="barEl" width="120" height="10"></canvas>
        <span class="lim">{{ limits[1] }} dB FS</span>
      </span>
    </div>
    <div ref="el" class="plot" :class="{ blank: note }"></div>
    <p v-if="note" class="note">{{ note }}</p>
  </div>
</template>

<style scoped>
.specgram {
  font: 13px system-ui, sans-serif;
  margin-top: 1rem;
}
.bar {
  display: flex;
  justify-content: space-between;
  align-items: center;
  gap: 1rem;
  padding: 0.4rem 0;
  color: #444;
}
.scale {
  display: flex;
  align-items: center;
  gap: 0.4rem;
}
.scale canvas {
  display: block;
  border: 1px solid rgba(0, 0, 0, 0.15);
}
.lim {
  font-family: var(--mono, ui-monospace, monospace);
  font-size: 11px;
  color: #777;
  font-variant-numeric: tabular-nums;
}
.plot {
  width: 100%;
}
.note {
  margin: 0;
  padding-top: 0.3rem;
  color: #999;
  font-size: 12px;
}
</style>
