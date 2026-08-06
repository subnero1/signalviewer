<script setup>
import { ref, shallowRef, watch, onMounted, onBeforeUnmount } from 'vue';
import uPlot from 'uplot';
import 'uplot/dist/uPlot.min.css';
import { buildPeaks, rawSlice, extent, RAW_THRESHOLD } from './peaks.js';
import { Y_SIZE, Y_LABEL, timeDecimals, makeClamp, navPlugin, deferRedraw } from './uplotnav.js';

const props = defineProps({
  // A real-valued signal: { ch: [Float32Array], fs, t0, label }. Complex
  // baseband is upconverted to passband by the caller (src/passband.js); this
  // component plots real samples only.
  signal: { type: Object, required: true },
  title: { type: String, default: '' },
  ranger: { type: Boolean, default: true },
  // Shared x window, two-way — lets other charts (the spectrogram) stay in step.
  xwin: { type: Object, default: null },
  height: { type: Number, default: 300 },
  rangerHeight: { type: Number, default: 90 }
});
const emit = defineEmits(['update:xwin']);

const el = ref(null);
const rangerEl = ref(null);
const plot = shallowRef(null);
const ranger = shallowRef(null);
const mode = ref('peaks');

const PALETTE = ['#2d7dd2', '#d2452d', '#2da84f', '#9b51e0', '#d99e00', '#00a3a3'];

let chs = null;
let peaks = null;
let yRange = [-1, 1];
let duration = 0;
// What the chart is currently showing. Doubles as the loop guard: the redraw
// below re-enters this path, and an unchanged window means there's nothing to do.
let applied = { raw: false, min: NaN, max: NaN };

/** Swap between the peak envelope and exact samples as the zoom crosses over. */
function swapData(u) {
  if (!chs) return;
  const { min, max } = u.scales.x;
  if (min == null) return;
  const visible = (max - min) * props.signal.fs;
  // Asymmetric threshold: leaving raw costs more than staying, so give it
  // hysteresis rather than letting it flap while dragging across the boundary.
  const wantRaw = applied.raw ? visible <= RAW_THRESHOLD * 2 : visible <= RAW_THRESHOLD;

  if (wantRaw) {
    if (applied.raw && applied.min === min && applied.max === max) return;
  } else if (!applied.raw) return;

  applied = { raw: wantRaw, min, max };
  mode.value = wantRaw ? 'raw' : 'peaks';
  u.setData(wantRaw ? rawSlice(chs, props.signal.fs, min, max) : peaks, false);
  // setData(_, false) deliberately skips uPlot's scale pass, which is also what
  // recomputes each series' visible index range. Without this the new array is
  // drawn through the old array's indices — invisible whenever the swap happens
  // at an unchanged x scale (a short signal, or a resize).
  u.redraw();
}

const scheduleSwap = deferRedraw(swapData);
const clamp = makeClamp(() => duration, () => props.signal.fs);

// The overview shades everything outside the main chart's window. Painting it
// directly, rather than driving uPlot's own select region from both sides,
// keeps the two charts from fighting over that shared bit of state — the
// ranger's drag is input only, and this is output only.
const windowShade = {
  hooks: {
    draw: (u) => {
      const m = plot.value;
      if (!m || m.scales.x.min == null) return;
      const { left, top, width, height } = u.bbox;
      const x0 = Math.round(u.valToPos(m.scales.x.min, 'x', true));
      const x1 = Math.round(u.valToPos(m.scales.x.max, 'x', true));
      const ctx = u.ctx;
      ctx.save();
      ctx.fillStyle = 'rgba(120, 132, 145, 0.24)';
      if (x0 > left) ctx.fillRect(left, top, x0 - left, height);
      if (x1 < left + width) ctx.fillRect(x1, top, left + width - x1, height);
      ctx.strokeStyle = 'rgba(45, 125, 210, 0.9)';
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(x0 + 0.5, top);
      ctx.lineTo(x0 + 0.5, top + height);
      ctx.moveTo(x1 - 0.5, top);
      ctx.lineTo(x1 - 0.5, top + height);
      ctx.stroke();
      ctx.restore();
    }
  }
};

// Zero amplitude is the reference every packet is read against, so it gets a
// darker rule than the regular grid. uPlot has no per-tick grid styling, so
// it's drawn directly.
const zeroLine = {
  hooks: {
    draw: (u) => {
      const y = Math.round(u.valToPos(0, 'y', true)) + 0.5;
      const { left, width } = u.bbox;
      const ctx = u.ctx;
      ctx.save();
      ctx.strokeStyle = 'rgba(0, 0, 0, 0.38)';
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(left, y);
      ctx.lineTo(left + width, y);
      ctx.stroke();
      ctx.restore();
    }
  }
};

// Wheel to zoom, shift-drag to pan live in uplotnav.js, shared with the
// spectrogram. onScale is what this chart adds: keep the data at the right
// resolution, repaint the overview, and publish the window to whoever is
// following it.
const nav = navPlugin({
  clamp,
  onScale: (u) => {
    scheduleSwap(u);
    ranger.value?.redraw(false); // repaint the shaded window, keep its paths
    const { min, max } = u.scales.x;
    if (min !== props.xwin?.min || max !== props.xwin?.max) emit('update:xwin', { min, max });
  }
});

// uPlot's live legend re-lays out as values change width, which slides every
// label to its right. Fixed decimal counts here, plus a reserved column width
// in CSS, keep the readout still. AMP_DECIMALS suits full-scale amplitudes;
// TIME_DECIMALS resolves 1us, finer than the deepest zoom the viewer allows.
const AMP_DECIMALS = 3;
const TIME_DECIMALS = 6;
const NO_VALUE = '--';

function channelSeries(width) {
  return props.signal.ch.map((_, i) => ({
    label: props.signal.ch.length > 1 ? `ch ${i}` : 'signal',
    stroke: PALETTE[i % PALETTE.length],
    width,
    value: (u, v) => (v == null ? NO_VALUE : v.toFixed(AMP_DECIMALS))
  }));
}

function mainOpts(width) {
  return {
    width,
    height: props.height,
    title: props.title || undefined,
    plugins: [zeroLine, nav],
    // Crosshair lines off; the legend still reports values on hover, and the
    // cursor position is still tracked for wheel-zoom anchoring.
    cursor: { x: false, y: false, points: { show: false }, drag: { x: true, y: false } },
    scales: {
      x: { time: false },
      // Pinned to the whole signal's extent so panning and zooming x never
      // rescales y — amplitudes stay comparable across the file.
      y: { range: () => yRange }
    },
    axes: [
      {
        label: 'Time (s)',
        // Zoomed in far enough, every tick rounds to the same second — grow the
        // precision with the zoom so ticks stay distinguishable.
        space: 90,
        values: (u, splits) => splits.map((v) => v.toFixed(timeDecimals(u.scales.x)))
      },
      { label: 'Amplitude (FS)', size: Y_SIZE, labelSize: Y_LABEL }
    ],
    series: [
      // Fixed precision, unlike the x axis ticks below, which stay adaptive —
      // ticks can afford to change width, the legend cannot.
      { label: 't', value: (u, v) => (v == null ? NO_VALUE : v.toFixed(TIME_DECIMALS) + ' s') },
      ...channelSeries(1)
    ]
  };
}

// The overview always shows the whole signal at envelope resolution — it never
// takes part in the raw/peaks swap, so it stays a stable map of the file.
function rangerOpts(width) {
  return {
    width,
    height: props.rangerHeight,
    cursor: { x: false, y: false, points: { show: false }, drag: { setScale: false, x: true, y: false } },
    legend: { show: false },
    scales: { x: { time: false }, y: { range: () => yRange } },
    axes: [
      { space: 90, values: (u, splits) => splits.map((v) => v.toFixed(1)) },
      // Drawn blank rather than hidden, so it reserves the same width as the
      // main chart's y axis and the two plot areas stay aligned.
      { size: Y_SIZE + Y_LABEL, ticks: { show: false }, values: (u, splits) => splits.map(() => '') }
    ],
    plugins: [windowShade],
    series: [{}, ...channelSeries(1)],
    hooks: {
      setSelect: [
        (u) => {
          if (u.select.width <= 0) return;
          const min = u.posToVal(u.select.left, 'x');
          const max = u.posToVal(u.select.left + u.select.width, 'x');
          // Hand the region back to uPlot cleared — the shading above is the
          // real indicator, and leaving both on screen would double up.
          u.setSelect({ left: 0, top: 0, width: 0, height: 0 }, false);
          plot.value?.setScale('x', clamp(min, max));
        }
      ]
    }
  };
}

/** Point both charts at the current signal, rebuilding the envelope. */
function load() {
  const sig = props.signal;
  chs = sig.ch;
  if (!chs?.length) return;
  duration = chs[0].length / sig.fs;
  peaks = buildPeaks(chs, sig.fs);
  yRange = extent(peaks);
  mode.value = 'peaks';
  applied = { raw: false, min: NaN, max: NaN };

  const width = el.value?.clientWidth || 800;
  plot.value?.destroy();
  ranger.value?.destroy();
  ranger.value = null;

  if (props.ranger) ranger.value = new uPlot(rangerOpts(width), peaks, rangerEl.value);
  plot.value = new uPlot(mainOpts(width), peaks, el.value);

  // Start at full extent explicitly rather than relying on uPlot's initial
  // auto-range, so the ranger has a well-defined selection from the outset.
  plot.value.setScale('x', props.xwin ?? { min: 0, max: duration });
}

function resize() {
  const width = el.value?.clientWidth;
  if (!width) return;
  plot.value?.setSize({ width, height: props.height });
  ranger.value?.setSize({ width, height: props.rangerHeight });
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
  ranger.value?.destroy();
});

watch(() => [props.signal, props.ranger], load);

// Follow the shared window. The inequality is the loop guard: onScale emits,
// the owner writes it back here, and this stops rather than emitting again.
watch(
  () => props.xwin,
  (w) => {
    const u = plot.value;
    if (!u || !w) return;
    if (u.scales.x.min !== w.min || u.scales.x.max !== w.max) u.setScale('x', w);
  }
);

defineExpose({
  reset: () => plot.value?.setScale('x', { min: 0, max: duration })
});
</script>

<template>
  <div class="viewer">
    <div class="bar">
      <span>{{ signal.label }}</span>
      <span class="mode">{{ mode === 'raw' ? 'exact samples' : 'min/max envelope' }}</span>
    </div>
    <div v-show="ranger" ref="rangerEl" class="ranger"></div>
    <div ref="el" class="plot"></div>
    <div class="hint">
      drag to zoom &middot; pinch or ctrl-wheel to zoom &middot; shift-drag to pan &middot; double-click to
      reset
      <template v-if="ranger"> &middot; drag the overview to jump</template>
      <template v-if="signal.ch.length > 1"> &middot; click a channel in the legend to hide it</template>
    </div>
  </div>
</template>

<style scoped>
.viewer {
  font: 13px system-ui, sans-serif;
}
.bar {
  display: flex;
  justify-content: space-between;
  gap: 1rem;
  padding: 0.4rem 0;
  color: #444;
}
.mode {
  color: #2d7dd2;
  white-space: nowrap;
}
.plot,
.ranger {
  width: 100%;
}
.hint {
  padding-top: 0.3rem;
  color: #999;
  font-size: 12px;
}
</style>

<style>
/* uPlot builds its DOM at runtime, so scoped styles never reach it — these
   rules are namespaced by hand instead. */

/* The legend is `u-inline u-live`: every cell is an inline-block, so a value
   that grows by a character pushes every row after it sideways. Reserving the
   widest each column can get, in a monospace face so `ch` is an exact advance,
   pins the layout no matter what the cursor reads. */
.viewer .u-legend .u-value {
  display: inline-block;
  min-width: 7ch; /* "-1.000", plus slack */
  text-align: right;
  font-family: var(--mono, ui-monospace, SFMono-Regular, Menlo, Consolas, monospace);
  font-variant-numeric: tabular-nums;
}
/* First row is the x series: "123.456789 s" is wider than any amplitude. */
.viewer .u-legend tr:first-child .u-value {
  min-width: 13ch;
}

/* The overview's selection marks the visible window, so it reads as a
   highlight rather than uPlot's default faint grey scrub. */
.ranger .u-select {
  background: rgba(45, 125, 210, 0.16);
  border-left: 1px solid rgba(45, 125, 210, 0.9);
  border-right: 1px solid rgba(45, 125, 210, 0.9);
}
</style>
