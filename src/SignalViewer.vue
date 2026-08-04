<script setup>
import { ref, shallowRef, watch, onMounted, onBeforeUnmount } from 'vue';
import uPlot from 'uplot';
import 'uplot/dist/uPlot.min.css';
import { buildPeaks, rawSlice, extent, RAW_THRESHOLD } from './peaks.js';

const props = defineProps({
  // A real-valued signal: { ch: [Float32Array], fs, t0, label }. Complex
  // baseband is upconverted to passband by the caller (src/passband.js); this
  // component plots real samples only.
  signal: { type: Object, required: true },
  title: { type: String, default: '' },
  ranger: { type: Boolean, default: true },
  height: { type: Number, default: 300 },
  rangerHeight: { type: Number, default: 90 }
});

const el = ref(null);
const rangerEl = ref(null);
const plot = shallowRef(null);
const ranger = shallowRef(null);
const mode = ref('peaks');

// Reserved for the y axis on both charts, so the ranger's plot area lines up
// with the main one and the selection sits directly over what it selects.
// The main chart's axis label adds LABEL on top of SIZE; the ranger has no
// label, so it reserves the sum as plain size instead.
const Y_SIZE = 76;
const Y_LABEL = 30;
const PALETTE = ['#2d7dd2', '#d2452d', '#2da84f', '#9b51e0', '#d99e00', '#00a3a3'];

let chs = null;
let peaks = null;
let yRange = [-1, 1];
let duration = 0;
// What the chart is currently showing. Doubles as the loop guard: the redraw
// below re-enters this path, and an unchanged window means there's nothing to do.
let applied = { raw: false, min: NaN, max: NaN };
let swapQueued = false;

/**
 * The swap must not run inside uPlot's commit cycle. uPlot's commit() no-ops
 * while a commit is already queued, and that flag stays set for the whole of
 * _commit — which is where the setScale hook fires. A redraw requested from
 * there is silently dropped. A microtask lands just after the commit finishes
 * and still before paint, so nothing flashes.
 */
function scheduleSwap(u) {
  if (swapQueued) return;
  swapQueued = true;
  queueMicrotask(() => {
    swapQueued = false;
    swapData(u);
  });
}

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

// Keep the window inside the signal and never let it shrink below a few
// samples — a sub-sample window contains nothing to draw, so the trace would
// silently vanish.
const MIN_SAMPLES = 8;

function clamp(min, max) {
  const span = Math.min(Math.max(max - min, MIN_SAMPLES / props.signal.fs), duration);
  const lo = Math.max(0, Math.min(duration - span, (min + max) / 2 - span / 2));
  return { min: lo, max: lo + span };
}

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

/** Decimal places needed for two adjacent x ticks to read differently. */
function timeDecimals({ min, max }) {
  return Math.max(0, Math.min(9, Math.ceil(-Math.log10((max - min) / 10)) + 1));
}

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

// Wheel to zoom, shift-drag to pan. uPlot ships neither; plain drag-select
// zoom and double-click reset are its own.
const navPlugin = {
  hooks: {
    ready: (u) => {
      u.over.addEventListener(
        'wheel',
        (e) => {
          e.preventDefault();
          const { min, max } = u.scales.x;
          const at = u.posToVal(u.cursor.left ?? u.over.clientWidth / 2, 'x');
          const f = e.deltaY < 0 ? 0.75 : 1 / 0.75;
          u.setScale('x', clamp(at - (at - min) * f, at + (max - at) * f));
        },
        { passive: false }
      );

      u.over.addEventListener(
        'mousedown',
        (e) => {
          if (!e.shiftKey || e.button !== 0) return;
          e.stopPropagation(); // keep uPlot's drag-select from also firing
          e.preventDefault();
          const perPx = (u.scales.x.max - u.scales.x.min) / u.over.clientWidth;
          const x0 = e.clientX;
          const { min, max } = u.scales.x;
          const move = (ev) => {
            const d = (x0 - ev.clientX) * perPx;
            u.setScale('x', clamp(min + d, max + d));
          };
          const up = () => {
            window.removeEventListener('mousemove', move);
            window.removeEventListener('mouseup', up);
          };
          window.addEventListener('mousemove', move);
          window.addEventListener('mouseup', up);
        },
        true // capture, so we get it before uPlot's own handler
      );
    },
    setScale: (u, key) => {
      if (key !== 'x') return;
      scheduleSwap(u);
      ranger.value?.redraw(false); // repaint the shaded window, keep its paths
    }
  }
};

function channelSeries(width) {
  return props.signal.ch.map((_, i) => ({
    label: props.signal.ch.length > 1 ? `ch ${i}` : 'signal',
    stroke: PALETTE[i % PALETTE.length],
    width
  }));
}

function mainOpts(width) {
  return {
    width,
    height: props.height,
    title: props.title || undefined,
    plugins: [zeroLine, navPlugin],
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
      { label: 't', value: (u, v) => (v == null ? '' : v.toFixed(timeDecimals(u.scales.x)) + ' s') },
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
  plot.value.setScale('x', { min: 0, max: duration });
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
      drag to zoom &middot; wheel to zoom &middot; shift-drag to pan &middot; double-click to reset
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
/* The overview's selection marks the visible window, so it reads as a
   highlight rather than uPlot's default faint grey scrub. */
.ranger .u-select {
  background: rgba(45, 125, 210, 0.16);
  border-left: 1px solid rgba(45, 125, 210, 0.9);
  border-right: 1px solid rgba(45, 125, 210, 0.9);
}
</style>
