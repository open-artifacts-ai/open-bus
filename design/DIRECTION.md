# Visual direction: Studio (adopted)

Adopted verbatim from Open Artifacts' Studio direction
(`~/code/projects/openartifacts/design/DIRECTION.md`) on 2026-10-21, by user decision
recorded in `docs/superpowers/specs/2026-10-21-openbus-design.md` §Visual identity.
There was no mockup round: OpenBus does not pick its own direction, it inherits Studio.

## Type pairing

| Role                                          | Family                                                                                                      | Weights       |
| --------------------------------------------- | ----------------------------------------------------------------------------------------------------------- | ------------- |
| Everything (UI, headings, body text)          | **Geist** (Google Fonts), falling back to `ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif` | 400, 500, 600 |
| Code, version numbers, tokens, keyboard hints | **Geist Mono**, falling back to `ui-monospace, "SF Mono", Menlo, monospace`                                 | 400, 500      |

One family carries the whole hierarchy through size and weight. There's no serif: D2's `--ob-font-serif` aliases the sans stack.

## Neutral ramp

| Token         | Light     | Dark      | Use                                                                                         |
| ------------- | --------- | --------- | ------------------------------------------------------------------------------------------- |
| bg            | `#EEF0F3` | `#131518` | Page behind cards                                                                           |
| chrome        | `#F5F6F8` | `#17191D` | Sidebar, title bar, side panel                                                              |
| surface       | `#FFFFFF` | `#1C1F23` | Cards, inputs, menus                                                                        |
| surface-2     | `#F6F7F9` | `#212429` | Segmented controls, raised rows                                                             |
| sunken        | `#ECEEF1` | `#181A1E` | Counts, empty bars                                                                          |
| divider       | `#E0E3E8` | `#2C3037` | Decorative hairlines inside a surface; never a control boundary                             |
| border        | `#BEC4CD` | `#3B414A` | Control and card boundaries (≥ 1.5:1 on bg)                                                 |
| border-strong | `#848B95` | `#676E78` | Checkboxes, timeline nodes, hover borders (≥ 3:1 on bg, surface and surface-2, WCAG 1.4.11) |
| text          | `#15181C` | `#E9EBEE` | Primary text; also the primary button fill                                                  |
| text-2        | `#454C56` | `#B7BDC6` | Secondary text                                                                              |
| text-muted    | `#5F6670` | `#9097A1` | Metadata, placeholders                                                                      |

## Accent

One accent: **`#2350D0`** in light and **`#7F9CFF`** in dark. The accent marks **state only**: live presence, the selected row, and focus rings. Primary actions are ink (`text` fill), not accent.

| Token                  | Light                 | Dark                  | Use                                                         |
| ---------------------- | --------------------- | --------------------- | ----------------------------------------------------------- |
| accent                 | `#2350D0`             | `#7F9CFF`             | State marks, fills                                          |
| accent-fg              | `#1D45B8`             | `#A3B8FF`             | Accent-colored text, usually on accent-soft                 |
| accent-soft            | `#E7EDFC`             | `#1F2A4A`             | Tinted badge and row backgrounds                            |
| accent-text            | `#FFFFFF`             | `#131518`             | Text drawn on an accent fill                                |
| focus                  | `#2350D0`             | `#7F9CFF`             | Same as accent; 2px outline, 2px offset (5.88 / 7.06 on bg) |
| success / success-soft | `#157A3A` / `#E3F3E8` | `#5BC77F` / `#173022` |                                                             |
| success-fg             | `#157A3A`             | `#6FD08F`             | Success-colored text on success-soft (the `public` badge)   |
| danger / danger-soft   | `#BE2F1C` / `#FBE7E3` | `#FF7F6B` / `#3A1E1A` |                                                             |
| warning / warning-soft | `#8A5A00` / `#FBF0D9` | `#E7B44F` / `#352914` |                                                             |

The status badges are `Live` in success, `Queued` in warning, and `Revoked` in danger, each with its word and a dot. Badge text uses the lighter foreground in dark: `Live` is `success-fg` (`#6FD08F`) on `success-soft`.

## Brand mark

The mark is a hub: three open rings in an upright triangle (one on top, two on the base), each joined by a short spoke to an open-ring hub in the middle. It draws on a 32x32 viewBox with a 2.6 stroke and round caps, no fill. The hub and spokes are ink (`text`, or `currentColor` inline); the rings carry the brand colors, top blue, bottom-left orange, bottom-right red. The brand colors belong to the mark only: never text, never state (that is the accent's job).

| Token        | Light     | Dark      | Use                                                     |
| ------------ | --------- | --------- | ------------------------------------------------------- |
| brand-blue   | `#2F6BFF` | `#2F6BFF` | Top ring                                                |
| brand-orange | `#E55F00` | `#FF6A00` | Bottom-left ring (light is darkened to clear 3:1 on bg) |
| brand-red    | `#FF2D55` | `#FF2D55` | Bottom-right ring                                       |

Each ring color is at least 3:1 (WCAG 1.4.11, non-text) on `bg` and `surface` in both themes: orange 3.08 / 3.52 light and 6.37 / 5.76 dark, blue 3.94 / 4.50 and 4.07 / 3.68, red 3.19 / 3.65 and 5.02 / 4.54.

Sources live in `packages/ui/src/brand`: `mark.svg` (ink in `currentColor`, rings in `var(--ob-brand-*)` with light fallbacks), `favicon.svg` (self-contained, dark values under `prefers-color-scheme`), and the PNG set (16, 32, 512 on transparent; the 180 apple-touch icon on `bg`) plus `favicon.ico` (the 16 and 32 PNGs, the implicit fallback at `/favicon.ico`), rendered by `node apps/landing/scripts/shots.mjs favicons`. The React mark is `BrandMark` in `@ob/ui/shadcn`. The approval and edge pages inline a compact monochrome copy in `currentColor`, with no brand colors, to stay inside their 8 KB budget without new CSS: the colored copy measured 8289 B on the device-approval mock at max field lengths, about 97 B over, so restoring color needs roughly 100 B saved elsewhere on those pages. `favicon-512.png` stays in the sources only; it is not served until a web manifest exists.

## Corner radius scale

| Token     | Value | Use                                     |
| --------- | ----- | --------------------------------------- |
| radius-sm | 4px   | Badges, kbd, inline code, small buttons |
| radius-md | 6px   | Buttons, inputs, menus, code blocks     |
| radius-lg | 8px   | Cards, panels, list containers          |

Avatars are round.

## Notes for D2 (tokens)

These are the measured contrasts, with WCAG AA as the bar:

| Pair                       | Light | Dark |
| -------------------------- | ----- | ---- |
| text on bg                 | 15.6  | 15.3 |
| text on surface            | 17.8  | 13.9 |
| text-muted on bg           | 5.08  | 6.21 |
| border on bg               | 1.54  | 1.78 |
| accent-text on accent      | 6.71  | 7.06 |
| border-strong on bg        | 3.01  | 3.55 |
| border-strong on surface   | 3.44  | 3.21 |
| border-strong on surface-2 | 3.21  | 3.02 |
| success on success-soft    | 4.71  | 6.69 |
| success-fg on success-soft | 4.71  | 7.48 |
- **Border.** The mockup's hairline `#E0E3E8` / `#2C3037` measures only 1.13 / 1.38 against bg, below D2's 1.5:1. It becomes `divider`, and `--ob-border` takes the stronger `#BEC4CD` / `#3B414A`. This deliberately departs from the mockup.
- **accent-text vs accent-fg.** D2's `--ob-accent-text` is the color drawn _on_ an accent fill. The mockup's accent-colored text becomes the extra token `--ob-accent-fg`.

## Rationale

Studio fits the brief, "a calm, document-first tool", by treating the chrome as a precise instrument that recedes. The cool gray neutrals and a single sans let agent names, machine labels and message text supply all the visual interest. Dense rows and compact cards suit a roster that grows to dozens of agents across machines. Hierarchy comes from size, weight, and the three-step text ramp, not from color. Restricting the blue accent to state (live presence, selection, focus) keeps it meaningful: when something is blue, it's telling you something. Geist with Geist Mono gives code, version numbers, and agent names a consistent technical voice without a second display face.

## OpenBus additions

- **Prefix.** Every custom property is `--ob-*`. `packages/ui/src/tokens/tokens.css` is the
  only definition; `packages/ui/src/tokens/index.ts` mirrors its colors and
  `packages/ui/test/sync.test.ts` fails if they drift.
- **State colors carry bus semantics.** `success` is a live or delivered thing (a connected
  machine, a `delivered` receipt), `warning` is waiting (a queued message, an expiring code),
  `danger` is refused or revoked, `accent` marks namespace and global state and focus.
  A machine row is never green because it is important; it is green because it is connected.
- **Terminal.** The `open-bus` CLI derives its palette from this ramp. See
  `design/cli/PALETTE.md`. The one exception to "one accent": the terminal's success,
  warning and danger map to ANSI green, yellow and red, because a terminal has no badges.
- **No-JS pages.** `design/screens/device-approval.html` inlines these values and loads
  nothing (no font request, no favicon dependency beyond same-origin). It is under 8 KB.
