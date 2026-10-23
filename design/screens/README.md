# Screens (Track D)

High-fidelity screens in the Studio direction (`design/DIRECTION.md`). Frontend matches
`machines.html` and `live.html`; Backend renders `device-approval.html` and the states in
`edge-pages.html`; the client track implements `../cli/transcript.md`.

## How to view

Open the file in a browser (`file://…/design/screens/machines.html`), or run `npx serve` from
the repo root and open `http://localhost:3000/design/screens/<file>`. Use the server if your
browser blocks the relative `tokens.css` link on `file://`. Every screen except
`device-approval.html` (which follows `prefers-color-scheme` only, because it has no
JavaScript) reads `?theme=light|dark`, plus the params below, and carries OA's
`Mockup controls` pill bar at the bottom with the same choices, so the artifacts published to
artifacts.leourbina.com are fully explorable without query strings.

Each screen is designed for 1280 px and 390 px wide, with no horizontal page scroll.

## Screens

| File                   | Screen                            | Params                                                                                                 | Notes                                                                                          |
| ---------------------- | --------------------------------- | ------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------- |
| `device-approval.html` | Device approval (Worker template) | none                                                                                                   | No JS, inlined tokens, under 8 KB. Backend substitutes the placeholders in its header comment. |
| `edge-pages.html`      | Expired, denied, unknown, not-you | `state=expired\|denied\|unknown\|not-you`                                                              | Renders every state at once when the param is omitted.                                         |
| `machines.html`        | Machines                          | `theme`, `state=default\|empty\|loading\|error`, `menu=none\|row\|confirm`, `toast=none\|revoked`      | Rows with revoke.                                                                              |
| `live.html`            | Live agents and namespaces        | `theme`, `state=default\|empty\|loading\|error`, `ns=<namespace>\|global`, `filter=none\|live\|closed` | Roster with reachability.                                                                      |

## Shared rules

- Colors come only from `../../packages/ui/src/tokens/tokens.css`. Screens add no new color.
- Copy has no em dashes. Machine labels, agent names and codes use the mono stack.
- Status is never color alone: every badge has a word and a dot.
