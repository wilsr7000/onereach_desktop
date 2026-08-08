# The Invisible Machine — Onereach.ai Lite design language

> **The machine organizes. The data speaks. The human leaves marks.**
> The best machine is invisible: the interface disappears so the work
> can be loved.

The influences (Tufte's honesty × Apple's restraint × Nirvana's soul)
were scaffolding; the creed above is the building. Apple designed the
object. Tufte designed the information. Nirvana scribbled all over it —
and nobody cleaned it up. A precision instrument made by people who
distrust polish: low visual density from six feet away, high
information density from six inches away.

The name is the thesis, borrowed from the house canon — *Age of
Invisible Machines*. Software at its best gets out of the way; you feel
the outcome, not the mechanism. This is the visual constitution for
Lite, and every surface answers to it. When a choice is unclear,
re-read the three voices and pick the one that serves the *content* — a
user's Spaces, playbooks, agents — over the chrome around it.

## The three voices

**Tufte — data-ink.** Maximize the ratio of meaning to pixels. Fewer
boxes; let whitespace do the structural work borders used to. Rich,
quiet typography carries hierarchy — a serif for the moments that
matter, tabular numerals for every count and version, small-caps
section labels instead of heavy dividers. No chartjunk, no gradients
for decoration's sake, no shadow where a hairline will do. Small
multiples: the kind-accent tiles (violet playbook, teal transcript,
emerald knowledge, blue journey, amber agent) must read as *one
family* — same saturation, same weight, differing only in hue.

**Apple — one system, obsessive.** A single modular type scale. A
single 4px spacing grid. One radius family, one shadow family, one
motion curve. Focus rings that are beautiful *and* accessible, on every
interactive element, no exceptions. Materials — a whisper of
translucency on elevated surfaces. Motion springs; it never travels in
a straight line. Alignment is a discipline, not an accident. Delight
lives in the smallest details: the hover, the settle, the way a thing
arrives.

**Nirvana — soul and grit.** The machine is not sterile. The dark has
warmth and a barely-there grain, like tape hiss under a great record.
Copy is human — direct, occasionally wry, never corporate. Empty
states have a pulse. The seams show, on purpose, tastefully — *come as
you are*. The **cap-chew** — the chewed-bullet mark from WISER
Playbooks (`lite/assets/capchewlogo.jpg`, vector `capchew-icon.svg`) —
is the thesis in one image: a handmade mark on the machine, the melting
smiley's cousin. Wherever the app can be a person instead of a form, it
is.

## Tokens (the law) — `lite/signature.css`

**Type scale** (1.2 modular, base 13px):
`--or-text-2xs 11 · --or-text-xs 12 · --or-text-sm 13 · --or-text-md 15
· --or-text-lg 18 · --or-text-xl 22 · --or-text-2xl 28`.
Display serif (`--or-font-display`, "New York"/Georgia) is reserved for
heroes and section identity — never body. Tabular numerals
(`.or-tnum`) on all data.

**Spacing** — 4px grid: `--or-space-1 4 … --or-space-6 32`.

**Radius** — `sm 6 · md 10 · lg 14 · xl 18`. Nothing sharp, nothing
bubbly.

**Motion** — `--or-ease-spring: cubic-bezier(0.22, 1, 0.36, 1)` is the
default for anything that moves. `--or-ease-out` for quiet fades. Every
animation is wrapped by `prefers-reduced-motion`.

**Focus** — `--or-focus-ring` is the *only* focus style. Beautiful blue
halo, 2px offset. It appears on `:focus-visible`, never on mouse click.

**Color** — the neutrals stay cool and deep (Tufte quiet); warmth
enters through the accent temperature and the grain, not the base. The
kind-accents are tuned as a set.

## The three typographic voices

Typography declares who is speaking, before a word is read:

- **System** — clean sans (`-apple-system`). The chrome. Silent,
  neutral, precise. Buttons, nav, labels.
- **Knowledge** — the editorial serif (`--or-font-display`). What is
  known: figures, findings, section identity, the North Star.
- **Human** — traces of the hand (handwriting-adjacent marks, the ✎
  line, rough circles, strikethroughs). Reserved for what a *person*
  contributed: annotations, marginalia, crossed-out hypotheses.

The rule is functional, not ornamental: machine-generated content is
typeset; human contributions keep the hand. Uncertain relationships are
pencil (dashed, lighter); established ones are crisp ink. Color is data,
never decoration — the base stays monochrome so the kind-accent dots
carry authority.

## Fun — the cap-chew family

The cap-chew (the chewed bullet) is licensed to have relatives — the ✎
pen-mark in empty states is one, the breathing hexagon another. Fun is
*earned*, never loud, and always removable by `prefers-reduced-motion`:

- Empty states get a hand-drawn ✎ line with a heartbeat, not a shrug.
- The hexagon mark breathes, slowly, when idle.
- "Loading…" gets character (quiet, never jokey on serious surfaces).
- The playbook step-bullet *is* a bullet — the cap-chew mark, chewing
  into color as steps complete (its blue+gold already are the app's
  accent+playbook hues — the logo and the system rhyme).
- One honest easter egg where it belongs, in the Nirvana spirit.

## The test

Before shipping any surface, ask: *Would someone screenshot this
because it's beautiful?* If not, it isn't done. And: *Does it feel made
by people who care, or generated by a template?* If the latter, add
soul or subtract chrome until it doesn't.
