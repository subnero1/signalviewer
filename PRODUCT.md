# Product

## Register

product

## Users

Engineers working with UnetStack underwater acoustic modems — typically at a
desk under normal office light, reviewing captures pulled off a modem after a
tank or field test. They arrive with a specific question ("did the packet at
~13 s decode cleanly?", "how much noise is on channel 2?") and a file that is
often tens of megabytes and tens of millions of samples. They frequently
compare several captures across one test session.

## Product Purpose

Open a UnetStack signal capture and find things in it. Two formats:
`rec-*.dat` passband recordings (one signal, several channels) and
`signals-*.txt` baseband dumps (many signals, one plotted at a time).

Success is: the file opens, the whole capture is legible at a glance, and
zooming from the full 38 seconds down to individual samples stays smooth
enough that the user never waits on the interface to think.

## Brand Personality

Precise, quiet, instrument-like. It is a measuring tool, not a product demo.
It should feel closer to a bench instrument's readout than to a web app —
confident enough to show dense data without decoration, and calm enough to
stare at for an hour.

## Anti-references

- SaaS dashboard chrome: stat tiles, KPI rows, gradient headers, card grids.
- "Hacker console" cosplay — neon-on-black terminal styling as a costume
  rather than a considered reading environment.
- Anything that decorates the plot. The waveform is the content; shell styling
  must never compete with it for attention.
- Marketing-page grammar in a tool: hero sections, tracked-uppercase eyebrows,
  numbered section markers.

## Design Principles

1. **The data is the interface.** Every pixel of chrome must justify itself
   against showing more signal. When in doubt, remove the chrome.
2. **Earned familiarity.** Standard affordances — native `<select>`, a real
   file input, uPlot's own legend for channel toggling. Never reinvent a
   control for flavour; the tool should disappear into the task.
3. **Don't say the same thing twice.** The viewer owns signal metadata; the
   shell owns file and selection state. Duplicated readouts are a bug.
4. **Honest affordances.** If a panel looks droppable it accepts drops; if a
   long operation blocks, it says so before it blocks.
5. **Never silently rescale.** Amplitudes stay comparable across a file and
   across zoom levels, so what the user sees at 38 s and at 8 samples can be
   trusted as the same measurement.

## Accessibility & Inclusion

- Target WCAG 2.1 AA. Body text ≥ 4.5:1; verified against the tinted-neutral
  background, not assumed.
- Fully keyboard operable: the visually-hidden file input keeps focus order
  intact and surfaces its focus ring on the visible label.
- `prefers-reduced-motion` is honoured; the only looping animation (the reading
  indicator) collapses to a static state.
- Colour is never the sole carrier of meaning: channel series are labelled
  `ch 0…ch 3` in the legend as well as coloured. **Known gap:** the channel
  palette beyond the first two has not been checked for deuteranopia /
  protanopia separation.
