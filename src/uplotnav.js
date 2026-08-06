// Shared uPlot chrome: the interactions and axis metrics the waveform and the
// spectrogram both need. Extracted from SignalViewer.vue so the two charts
// behave identically and line up, rather than drifting apart in two copies.

// Reserved for the y axis on every chart, so their plot areas line up and a
// time on one sits directly above the same time on the next. A chart with an
// axis label splits this into SIZE + LABEL; one without reserves the sum as
// plain size.
export const Y_SIZE = 76;
export const Y_LABEL = 30;

/** Decimal places needed for two adjacent x ticks to read differently. */
export function timeDecimals({ min, max }) {
  return Math.max(0, Math.min(9, Math.ceil(-Math.log10((max - min) / 10)) + 1));
}

/**
 * Keep the window inside the signal and never let it shrink below a few
 * samples — a sub-sample window contains nothing to draw, so the trace would
 * silently vanish.
 */
export const MIN_SAMPLES = 8;

export function makeClamp(getDuration, getFs) {
  return (min, max) => {
    const duration = getDuration();
    const span = Math.min(Math.max(max - min, MIN_SAMPLES / getFs()), duration);
    const lo = Math.max(0, Math.min(duration - span, (min + max) / 2 - span / 2));
    return { min: lo, max: lo + span };
  };
}

/**
 * Run `fn` just after uPlot's current commit, and only once per commit.
 *
 * uPlot's commit() no-ops while a commit is already queued, and that flag stays
 * set for the whole of _commit — which is where the setScale hook fires. A
 * redraw requested from there is silently dropped. A microtask lands just after
 * the commit finishes and still before paint, so nothing flashes.
 */
export function deferRedraw(fn) {
  let queued = false;
  return (...args) => {
    if (queued) return;
    queued = true;
    queueMicrotask(() => {
      queued = false;
      fn(...args);
    });
  };
}

/**
 * Ctrl/cmd-wheel to zoom, shift-drag to pan. uPlot ships neither; plain
 * drag-select zoom and double-click reset are its own. `onScale(u)` runs after
 * any x change.
 *
 * Zoom deliberately needs a modifier. With a waveform and a spectrogram per
 * channel the page runs several screens tall, and a plain wheel that
 * preventDefaults would swallow the scroll that gets you past the charts. The
 * modifier is also how macOS reports a trackpad pinch, so pinch-to-zoom works
 * without any extra handling.
 */
export function navPlugin({ clamp, onScale }) {
  return {
    hooks: {
      ready: (u) => {
        u.over.addEventListener(
          'wheel',
          (e) => {
            if (!e.ctrlKey && !e.metaKey) return; // plain wheel scrolls the page
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
        if (key === 'x') onScale(u);
      }
    }
  };
}
