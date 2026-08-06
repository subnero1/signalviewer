<script setup>
import { ref, shallowRef, computed, watch } from 'vue';
import SignalViewer from './SignalViewer.vue';
import Spectrogram from './Spectrogram.vue';
import { parseSignals, readSignal, parseRecording } from './parse.js';
import { toPassband } from './passband.js';

const dump = shallowRef(null); // parseSignals() result, for signals-*.txt
const signal = shallowRef(null); // normalized signal currently plotted
const error = ref('');
const name = ref('');
const loading = ref(false);
const dragging = ref(false);

const picked = ref(0);

// The x window every chart shares. Owned here rather than by either chart, so
// zooming any one of them moves all of them. Reset whenever the signal changes.
const xwin = ref(null);
watch(signal, (s) => {
  xwin.value = s ? { min: 0, max: s.ch[0].length / s.fs } : null;
});
// Deliberately does NOT repeat rate / channels / duration — the viewer's own
// status line already carries those. These are the facts it doesn't show.
const summary = computed(() => {
  const s = signal.value;
  if (!s) return null;
  const tags = [`${s.ch[0].length.toLocaleString()} samples`];
  // Say so when what's plotted isn't what was in the file.
  if (s.source) {
    tags.unshift(`baseband ${s.source.fs / 1000} kHz → passband ×${s.source.sps}`);
  } else {
    tags.unshift('passband');
  }
  return tags;
});

async function loadFile(file) {
  if (!file) return;
  error.value = '';
  dump.value = null;
  signal.value = null;
  picked.value = 0;
  name.value = file.name;
  loading.value = true;
  // Parsing blocks the main thread for ~100ms on a 59MB recording, and the
  // file read before it is slower still. Yield through a frame so the reading
  // state actually paints instead of the UI just freezing.
  await new Promise((r) => requestAnimationFrame(() => setTimeout(r, 0)));
  try {
    if (file.name.endsWith('.dat')) {
      signal.value = toPassband(parseRecording(await file.arrayBuffer()));
    } else {
      const parsed = parseSignals(await file.text());
      if (!parsed.index.length) throw new Error('no RxBasebandSignalNtf records found');
      dump.value = parsed;
      pick(0);
    }
  } catch (err) {
    error.value = err.message;
  } finally {
    loading.value = false;
  }
}

function pick(i) {
  picked.value = i;
  try {
    signal.value = toPassband(readSignal(dump.value, i));
    error.value = '';
  } catch (err) {
    signal.value = null;
    error.value = err.message;
  }
}

function onDrop(e) {
  dragging.value = false;
  loadFile(e.dataTransfer?.files?.[0]);
}

const shortTime = (ms) => new Date(ms).toISOString().slice(11, 23);
</script>

<template>
  <div
    class="app"
    :class="{ 'is-dragging': dragging }"
    @dragover.prevent="dragging = true"
    @dragleave.self="dragging = false"
    @drop.prevent="onDrop"
  >
    <!-- One input for the whole app; both entry points are <label for>. -->
    <input id="pickfile" type="file" accept=".txt,.dat" class="sr" @change="loadFile($event.target.files[0])" />

    <header class="topbar">
      <div class="brand">
        <svg class="mark" viewBox="0 0 24 16" aria-hidden="true">
          <path
            d="M1 8h2.5l1.7-6 2.4 12 2.2-9 1.9 7 1.6-4 1.5 3H23"
            fill="none"
            stroke="currentColor"
            stroke-width="1.6"
            stroke-linecap="round"
            stroke-linejoin="round"
          />
        </svg>
        <h1>Signal Viewer</h1>
      </div>

      <div v-if="name" class="source">
        <span class="fname" :title="name">{{ name }}</span>
        <label class="btn btn-quiet" for="pickfile">Change…</label>
      </div>
    </header>

    <main>
      <p v-if="error" class="error" role="alert">
        <strong>Could not read that file.</strong> {{ error }}
      </p>

      <p v-if="loading" class="status" role="status" aria-live="polite">
        <span class="pulse" aria-hidden="true"></span>Reading {{ name }}…
      </p>

      <!-- Empty state doubles as the drop target, so the panel isn't lying
           about accepting a drag. -->
      <section v-if="!signal && !loading" class="empty">
        <h2>Open a signal file</h2>
        <p class="lede">Drop one anywhere on this window, or pick it below.</p>
        <label class="btn btn-primary" for="pickfile">Choose file…</label>
        <dl class="formats">
          <div>
            <dt><code>rec-*.dat</code></dt>
            <dd>Passband recording — one signal, every channel.</dd>
          </div>
          <div>
            <dt><code>signals-*.txt</code></dt>
            <dd>Baseband dump — many signals, pick one to plot.</dd>
          </div>
        </dl>
      </section>

      <div v-if="signal" class="panel">
        <div class="meta">
          <div v-if="dump" class="field">
            <label for="signalsel">Signal</label>
            <select id="signalsel" :value="picked" @change="pick(Number($event.target.value))">
              <option v-for="(e, i) in dump.index" :key="i" :value="i">
                {{ i + 1 }} of {{ dump.index.length }} — {{ shortTime(e.time) }} · {{ e.len }} samples{{
                  e.rssi != null ? ` · ${e.rssi} dB` : ''
                }}
              </option>
            </select>
          </div>
          <ul v-if="summary" class="tags">
            <li v-for="t in summary" :key="t">{{ t }}</li>
          </ul>
        </div>

        <SignalViewer :signal="signal" :title="name" v-model:xwin="xwin" />
        <Spectrogram
          v-for="(_, i) in signal.ch"
          :key="i"
          :signal="signal"
          :channel="i"
          v-model:xwin="xwin"
        />
      </div>
    </main>
  </div>
</template>

<style>
:root {
  /* Neutrals tinted toward the chart's own blue rather than a default warm. */
  --bg: oklch(0.982 0.004 250);
  --surface: oklch(1 0 0);
  --surface-2: oklch(0.968 0.006 250);
  --line: oklch(0.905 0.008 250);
  --line-2: oklch(0.845 0.011 250);
  --ink: oklch(0.26 0.021 255);
  --ink-2: oklch(0.455 0.017 255);
  --ink-3: oklch(0.56 0.014 255);
  /* Matches the series stroke uPlot paints on the canvas, so the shell and the
     plot read as one system without touching the component. */
  --accent: #2d7dd2;
  --accent-ink: oklch(0.5 0.135 250);
  --accent-wash: oklch(0.955 0.026 250);
  --danger: oklch(0.505 0.185 25);
  --danger-wash: oklch(0.963 0.032 25);
  --r: 7px;
  --ease: cubic-bezier(0.22, 1, 0.36, 1);
  --sans: system-ui, -apple-system, 'Segoe UI', sans-serif;
  --mono: ui-monospace, SFMono-Regular, 'SF Mono', Menlo, Consolas, monospace;
}

* {
  box-sizing: border-box;
}

body {
  margin: 0;
  background: var(--bg);
  color: var(--ink);
  font-family: var(--sans);
  font-size: 0.875rem;
  line-height: 1.5;
  -webkit-font-smoothing: antialiased;
}
</style>

<style scoped>
.app {
  min-height: 100vh;
}

/* --- top bar --------------------------------------------------------- */
.topbar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 1rem;
  flex-wrap: wrap;
  padding: 0.75rem clamp(1rem, 4vw, 2rem);
  background: var(--surface);
  border-bottom: 1px solid var(--line);
}
.brand {
  display: flex;
  align-items: center;
  gap: 0.6rem;
  min-width: 0;
}
.mark {
  width: 26px;
  height: 18px;
  color: var(--accent);
  flex: none;
}
h1 {
  margin: 0;
  font-size: 1.0625rem;
  font-weight: 600;
  letter-spacing: -0.011em;
}
.dim {
  color: var(--ink-3);
  font-size: 0.75rem;
  padding-left: 0.6rem;
  border-left: 1px solid var(--line);
}
.source {
  display: flex;
  align-items: center;
  gap: 0.6rem;
  min-width: 0;
}
.fname {
  font-family: var(--mono);
  font-size: 0.75rem;
  color: var(--ink-2);
  background: var(--surface-2);
  border: 1px solid var(--line);
  border-radius: 5px;
  padding: 0.2rem 0.5rem;
  max-width: min(44ch, 100%);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

/* --- shared controls -------------------------------------------------- */
.sr {
  position: absolute;
  width: 1px;
  height: 1px;
  padding: 0;
  margin: -1px;
  overflow: hidden;
  clip-path: inset(50%);
  border: 0;
}
.btn {
  display: inline-block;
  padding: 0.4rem 0.85rem;
  border-radius: var(--r);
  border: 1px solid transparent;
  font: inherit;
  font-weight: 500;
  cursor: pointer;
  white-space: nowrap;
  transition: background-color 0.16s var(--ease), border-color 0.16s var(--ease);
}
.btn-primary {
  background: var(--accent);
  color: #fff;
}
.btn-primary:hover {
  background: var(--accent-ink);
}
.btn-quiet {
  background: var(--surface-2);
  border-color: var(--line-2);
  color: var(--ink);
}
.btn-quiet:hover {
  background: var(--line);
}
/* The real input is visually hidden, so its focus ring has to surface on
   whichever label is currently on screen. Only one is ever rendered. */
.app:has(#pickfile:focus-visible) .btn {
  outline: 2px solid var(--accent);
  outline-offset: 2px;
}

main {
  max-width: 1180px;
  margin: 0 auto;
  padding: clamp(1rem, 3vw, 1.75rem) clamp(1rem, 4vw, 2rem) 3rem;
}

/* --- states ----------------------------------------------------------- */
.error,
.status {
  display: flex;
  align-items: center;
  gap: 0.5rem;
  margin: 0 0 1rem;
  padding: 0.6rem 0.85rem;
  border-radius: var(--r);
  font-size: 0.8125rem;
}
.error {
  background: var(--danger-wash);
  color: var(--danger);
  border: 1px solid oklch(0.88 0.06 25);
}
.error strong {
  font-weight: 600;
}
.status {
  background: var(--accent-wash);
  color: var(--accent-ink);
  border: 1px solid oklch(0.9 0.05 250);
}
.pulse {
  width: 7px;
  height: 7px;
  border-radius: 50%;
  background: currentColor;
  animation: pulse 1.1s ease-in-out infinite;
}
@keyframes pulse {
  0%, 100% { opacity: 0.25; }
  50% { opacity: 1; }
}

.empty {
  background: var(--surface);
  border: 1px dashed var(--line-2);
  border-radius: 12px;
  padding: clamp(2rem, 6vw, 3.5rem) clamp(1.25rem, 5vw, 3rem);
  text-align: center;
  transition: border-color 0.18s var(--ease), background-color 0.18s var(--ease);
}
.is-dragging .empty {
  border-color: var(--accent);
  background: var(--accent-wash);
}
.empty h2 {
  margin: 0 0 0.3rem;
  font-size: 1.0625rem;
  font-weight: 600;
  letter-spacing: -0.008em;
  text-wrap: balance;
}
.lede {
  margin: 0 0 1.25rem;
  color: var(--ink-2);
}
.formats {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(260px, 1fr));
  gap: 0.5rem 2rem;
  max-width: 660px;
  margin: 2rem auto 0;
  padding-top: 1.5rem;
  border-top: 1px solid var(--line);
  text-align: left;
  font-size: 0.8125rem;
}
.formats dt {
  margin-bottom: 0.15rem;
}
.formats dd {
  margin: 0;
  color: var(--ink-2);
}
code {
  font-family: var(--mono);
  font-size: 0.78125rem;
  color: var(--accent-ink);
}

/* --- loaded panel ------------------------------------------------------ */
.panel {
  background: var(--surface);
  border: 1px solid var(--line);
  border-radius: 12px;
  padding: 0.5rem clamp(0.75rem, 2vw, 1.25rem) 1rem;
}
.meta {
  display: flex;
  align-items: center;
  /* justify-content: space-between; */
  gap: 1rem;
  flex-wrap: wrap;
  padding: 0.55rem 0.15rem;
  border-bottom: 1px solid var(--line);
}
.field {
  margin-right: auto;
  display: flex;
  align-items: center;
  gap: 0.55rem;
  min-width: 0;
}
.field label {
  color: var(--ink-2);
  font-size: 0.8125rem;
}
select {
  font: inherit;
  font-size: 0.8125rem;
  color: var(--ink);
  background: var(--surface-2);
  border: 1px solid var(--line-2);
  border-radius: 6px;
  padding: 0.3rem 0.45rem;
  font-variant-numeric: tabular-nums;
  /* A select's intrinsic width comes from its longest option, so it needs an
     explicit floor of 0 or it pushes the page wider on narrow screens. */
  flex: 1 1 auto;
  min-width: 0;
  max-width: 46ch;
}
select:focus-visible,
.btn:focus-visible {
  outline: 2px solid var(--accent);
  outline-offset: 2px;
}
.tags {
  margin-left: auto;
  display: flex;
  gap: 0.4rem;
  flex-wrap: wrap;
  list-style: none;
  justify-content: flex-end;
  padding: 0;
}
.tags li {
  font-family: var(--mono);
  font-size: 0.71875rem;
  color: var(--ink-2);
  background: var(--surface-2);
  border: 1px solid var(--line);
  border-radius: 5px;
  padding: 0.15rem 0.45rem;
  font-variant-numeric: tabular-nums;
}

@media (prefers-reduced-motion: reduce) {
  * {
    animation-duration: 0.01ms !important;
    animation-iteration-count: 1 !important;
    transition-duration: 0.01ms !important;
  }
}
</style>
