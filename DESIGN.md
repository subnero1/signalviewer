# Design

Visual system for the UnetStack Signal Viewer. Tokens live in the unscoped
`:root` block of `src/App.vue`; component styling is scoped alongside it.

## Theme

Light, single mode. Chosen deliberately, not by default: the plot is a thin
1px stroke over a large empty field, and dark backgrounds make thin
antialiased strokes bloom. Light also matches the ambient condition the tool
is actually used in — an office desk, not a darkened control room.

Colour strategy: **restrained**. Tinted neutrals plus one accent, well under
10% of surface area.

## Color

All neutrals carry a faint tint toward the accent's own hue (250) rather than
the reflexive warm cast. OKLCH throughout.

| Token | Value | Role |
|---|---|---|
| `--bg` | `oklch(0.982 0.004 250)` | Page field |
| `--surface` | `oklch(1 0 0)` | Panels, top bar, plot ground |
| `--surface-2` | `oklch(0.968 0.006 250)` | Inset controls, chips, tags |
| `--line` | `oklch(0.905 0.008 250)` | Hairlines, dividers |
| `--line-2` | `oklch(0.845 0.011 250)` | Control borders, dashed empty state |
| `--ink` | `oklch(0.26 0.021 255)` | Primary text |
| `--ink-2` | `oklch(0.455 0.017 255)` | Secondary text, metadata |
| `--ink-3` | `oklch(0.56 0.014 255)` | Tertiary labels only (≥4.5:1 on `--bg`) |
| `--accent` | `#2d7dd2` | Primary action, selection, series 0 |
| `--accent-ink` | `oklch(0.5 0.135 250)` | Accent text on light, hover fill |
| `--accent-wash` | `oklch(0.955 0.026 250)` | Status band, drag-target fill |
| `--danger` | `oklch(0.505 0.185 25)` | Error text |
| `--danger-wash` | `oklch(0.963 0.032 25)` | Error band |

**`--accent` is deliberately a hex, not OKLCH.** uPlot paints series strokes
onto a canvas from a JS string; keeping the shell's accent byte-identical to
the series-0 stroke is what makes the chart and the chrome read as one system.
Change one and you must change the other (`PALETTE` in `SignalViewer.vue`).

Body text is never lighter than `--ink-2`. Light-gray body copy on a tinted
near-white is the failure mode this palette exists to avoid.

## Typography

One family: `system-ui` stack for all UI. A monospace stack (`ui-monospace,
SFMono-Regular, Menlo, Consolas`) carries filenames, format literals, and
numeric tags — appropriate for an instrument, and it supplies texture without
introducing a display face.

Fixed rem scale (no fluid clamps on type — users view at consistent DPI):

| Step | Size | Use |
|---|---|---|
| 1.0625rem / 600 / -0.011em | 17px | `h1`, empty-state heading |
| 0.875rem | 14px | Body default |
| 0.8125rem | 13px | Controls, status bands |
| 0.75rem | 12px | Filename chip, tertiary labels |
| 0.71875rem | 11.5px | Metadata tags |

`font-variant-numeric: tabular-nums` on the signal selector and tags so digits
don't jitter between selections. `text-wrap: balance` on headings.

## Layout

- Full-bleed top bar (identity left, file state right), `flex-wrap` so it
  stacks rather than breaking at narrow widths.
- Content column: `max-width: 1180px`, fluid gutters via
  `clamp(1rem, 4vw, 2rem)`.
- Empty state and loaded content are a single panel each — no nested cards.
- Format list uses `repeat(auto-fit, minmax(260px, 1fr))`, so it reflows
  without a breakpoint.
- Radii: `12px` panels, `7px` buttons (`--r`), `5–6px` chips and controls.
- Verified free of horizontal overflow at 360 / 420 / 768 / 1024 / 1440.

## Components

- **Button** — `.btn` with `.btn-primary` (accent fill) and `.btn-quiet`
  (inset). Hover and focus-visible states defined for both.
- **File input** — visually hidden via `clip-path: inset(50%)`, driven by
  `<label for>`. Hidden rather than styled because Chrome renders it with a
  "No file chosen" string and shows that as an OS tooltip. Focus ring is
  forwarded to the visible label with `.app:has(#pickfile:focus-visible)`.
- **Status band** — `role="status"` for reading, `role="alert"` for errors.
- **Empty state** — teaches both file formats and doubles as the drop target.
- **Tags** — carry only what the viewer's own status line does not.

## Motion

Sparing, state-only. `--ease: cubic-bezier(0.22, 1, 0.36, 1)` (ease-out-quart)
at 160–180 ms on hover and drag-target transitions. One looping animation: the
1.1 s opacity pulse on the reading indicator.

No entrance choreography — the tool loads into a task.

`prefers-reduced-motion: reduce` collapses all animation and transition
durations to ~0.

## Boundaries

`SignalViewer.vue` owns everything inside the chart: series colours, axis and
grid rendering, the zero rule, the ranger shading. The shell does not reach
into it. The one shared contract is `--accent` ↔ `PALETTE[0]`.
