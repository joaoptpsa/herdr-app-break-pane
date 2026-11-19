# Break pane

A one-key action for the Herdr desktop app that moves the focused pane out of its tab into a new
tab of the same space, like tmux `break-pane`. The program keeps running with its scrollback; only
where it is shown changes.

## What you see

- Nothing of the mod itself: it opens as a 1×1 px popup with no frame and draws an empty `div`,
  then closes itself as soon as the move is done.
- The focused pane disappears from its tab and the remaining panes fill the space.
- A new tab appears in the same space, holding the same terminal, and it gets the keyboard. Herdr
  names the tab after the terminal's address (`t4f`).

## How it behaves

- `ctrl-space !` (also `ctrl-space shift-1`) runs `mod.open:break-pane`.
- It acts on `focused()`: the pane's terminal, its tab and its space.
- Refuses with a warning notification, changing nothing, when no pane has the keyboard, when the
  focused pane is a mod pane, or when the pane is the only one in its tab.
- Otherwise:
  1. `terminal.park {terminal}`.
  2. Waits, polling every 50 ms for up to 5 s, until no pane in `panes()` shows the terminal and
     its `terminals()` entry no longer has `keep: true`. If the pane is still there after 5 s,
     the park failed: an error notification, and the terminal stays where it was.
  3. If the shown space is not the one the pane came from, `space.select` it.
  4. `terminal.keep {terminal, place: "tab"}`, then waits the same way until a pane shows the
     terminal.
  5. If no pane appears, steps 3 and 4 run once more. If that fails too, an error notification
     says the terminal runs without a pane; clicking it runs `terminal.keep {terminal, place:
     "tab"}`.
  6. Closes its popup with `closeOverlay(props().overlay)`.
- If the popup is closed mid-move (Escape, a click beside it), `close()` runs the keep itself, or
  posts the same clickable error when it can't.
- Agent status plays no part.

## Built from

- One mod, `mods/break-pane/` (`main.js`, `mod.json`). No layout changes.
- `mod.json`: `{ "place": "none", "title": "Break pane", "overlay": { "kind": "popup", "frame":
  "none", "width": 1, "height": 1 } }`.
- `keys.json` binds it in `global`: `"ctrl-space !"` and `"ctrl-space shift-1"`, both
  `"mod.open:break-pane"`.
- `herdr` functions: `focused()`, `panes()`, `terminals()`, `run` for `terminal.park`,
  `terminal.keep` and `space.select`, `notify`, `props().overlay` with `closeOverlay`, and
  `checking()`.
- `gpui-kit`: `div`. The wait is a `cx.spawn` task started in `init` that awaits `cx.sleep(50)`.
- A `Phase` enum (`idle`, `parking`, `keeping`, `done`) tells `close()` whether the terminal may be
  without a pane.
- No `exec`, `fetch`, `hc` or file access.

## Watch out

- `run()` returns `null`. `terminal.park` and `terminal.keep` reply `pending: true` to scripts and
  finish in the background, so the mod watches `panes()` and `terminals()` to see them land
  instead of reading a reply. Keeping before the park lands races the core.
- `terminal.park` also removes the `herdr.space` and `herdr.tab` labels, so `terminal.keep` has no
  memory of the old space: it puts the tab in the shown space. That is why the mod re-selects the
  source space before keeping.
- Parking the only pane of a tab closes the tab, and parking the last pane of a space closes the
  space; the window then shows another space, possibly on another machine, and the keep would land
  there. Hence the refusal for one-pane tabs.
- A mod copy's tasks end when its overlay closes, so the popup must stay open until the keep has
  landed; closing it first strands a parked terminal. `close()` covers early closes.
- `checking()` returns early in `init`, so `herdr-app check` moves nothing.
- No `setTimeout`/`setInterval`, and each `cx` stays in the task that received it.

## Done when

- `herdr-app check mods/break-pane` passes.
- In a tab with two panes, one running `echo MARKER; sleep 900`, focusing that pane and pressing
  `ctrl-space !` leaves the other pane alone in the tab, and a new tab in the same space shows the
  same terminal address with `MARKER` in its scrollback and `sleep` still running (`hc get <t>`
  shows the same pid).
- The new tab has the keyboard, and `herdr-app status` shows no overlay left open.
- In a tab with one pane, the binding shows a warning and nothing moves.
