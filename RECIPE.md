# Break pane

A one-key action for the Herdr desktop app that moves the focused pane out of its tab into a tab of
its own, like tmux `break-pane`: in the same space, in another space on the same machine, or in a
new space. The program keeps running with its scrollback; only where it is shown changes.

## What you see

- A dialog titled `Break pane to`, one row per destination, each with a hint key badge, a label and
  dim secondary text:
  1. `New tab in this space`, only when the focused pane shares its tab with another pane.
  2. One row per other space on the source space's machine: its name, and its folder with `~` for
     home.
  3. `New space`, always last.
- Typing a hint key or clicking a row starts the move. The rows give way to one dim line,
  `Moving…`, until the move ends; then the dialog closes.
- The focused pane disappears from its tab, and a new tab holding the same terminal appears where
  you picked. It is called by its number, like any new tab.
- For another space or a new space, the window shows the destination for the moment the keep
  takes and then the original space again, all behind the dialog (the overlay is app-wide). If the
  move took the original space's last tab, that space is gone and the window stays on the
  destination.

## How it behaves

- `ctrl-space !` (also `ctrl-space shift-1`) runs `mod.open:break-pane`.
- `init` returns at once under `checking()`. Otherwise it reads `focused()` once: the pane's
  terminal, its tab (from `panes()`), its space, its `cwd`, and the space's `machine` from
  `spaces()`. The move uses these and never reads `focused()` for the target again.
- It refuses with a warning notification and closes, changing nothing, when no pane has the
  keyboard (`No pane has the keyboard.`) or the focused pane is a mod pane (`The focused pane is
  not a terminal.`).
- Rows, in order: `New tab in this space` when two or more `panes()` share the pane's `tab`; every
  space in `spaces()` other than the source whose `machine` equals the source's (null is this
  computer); `New space`. Hint keys are `1`–`9` then `arstgmneioqwfpbjluyzxcdvkh`; rows past that
  stay clickable without a hint. Rows and the key handler come from one function, so a hint always
  picks the row it labels.
- Keys: the dialog focuses a `cx.focus_handle()` in `init` and again 100 ms later, because it can
  open before the window has focus. `onKeyDown` stops propagation; Escape, `ctrl-g` and `ctrl-c`
  cancel. Keys do nothing while the move runs.
- Every move starts the same way:
  1. `terminal.park {terminal}`.
  2. Waits, polling every 50 ms for up to 5 s, until no pane in `panes()` shows the terminal and
     its `terminals()` entry no longer has `keep: true`. If the pane is still there after 5 s,
     the park failed: an error notification, and the terminal stays where it was.
- Keeping is the same everywhere: show the space (`space.select`, then poll until
  `focused().space` is it, up to 5 s), `terminal.keep {terminal, place: "tab"}`, wait for a pane
  to show the terminal. If that fails it runs once more; if the space is gone it keeps in the shown
  space. Once a pane shows the terminal, `tab.rename {id, name: ""}` on its tab; a failed rename is
  a warning notification.
- New tab in this space: keep in the source space.
- Another space:
  1. If the space is gone, keep in the source space instead and warn.
  2. Show it. If it does not become the shown space, keep in the source space instead and warn
     that the destination could not be shown.
  3. Keep there.
  4. `space.select` the source space again if it still exists.
  5. If the pane's tab is not one of the destination's tabs in `spaces()`, warn naming the space
     it landed in. It is not moved again.
- New space:
  1. `space.new {folder: cwd, machine, focus: true}` with no name, so the space is called after its
     first terminal, which is the moved one once the shell is gone. A failure keeps in the source
     space and warns.
  2. The new space is the one in `spaces()` that was not there before the call. Its only tab is the
     one `space.new` started.
  3. Show it, then keep there.
  4. `tab.close {id, confirmed: true}` on that first tab, ending its shell; never when it is the
     moved terminal's tab.
  5. `space.select` the source space again if it still exists.
- If any keep fails twice, an error notification titled `Terminal <t> is running without a pane`
  says what failed; clicking it runs `terminal.keep {terminal, place: "tab"}`.
- If the dialog is closed mid-move (Escape from the app, a click beside it, the binding again),
  `close()` keeps the terminal in the destination space when it exists (selecting it first),
  otherwise in the shown space, or posts the same clickable error when it can't.
- Agent status plays no part.

## Built from

- One mod, `mods/break-pane/` (`main.js`, `mod.json`). No layout changes.
- `mod.json`: `{ "place": "none", "title": "Break pane", "overlay": { "kind": "dialog", "width":
  420 } }`.
- `keys.json` binds it in `global`: `"ctrl-space !"` and `"ctrl-space shift-1"`, both
  `"mod.open:break-pane"`.
- `herdr` functions: `focused()`, `panes()`, `spaces()`, `terminals()`, `home()`, `theme()`,
  `run` for `terminal.park`, `terminal.keep`, `space.select`, `space.new`, `tab.rename` and
  `tab.close`, `notify`, `props().overlay` with `closeOverlay`, and `checking()`.
- `gpui-kit`: `div`; `gpui-base`: `h_flex`, `v_flex`. Rows follow the `pane-picker` mod: a hint
  badge (`accent` on `accent_foreground`, `raised` without a hint), the label in `foreground`,
  secondary text in `dim`, `hover` and `selected` (pressed) backgrounds, on `popover`.
- The move is a `cx.spawn` task started from the row's click or key handler; it awaits
  `cx.sleep(50)` to poll.
- A `Phase` enum (`idle`, `parking`, `keeping`, `done`) tells `render` whether to draw the rows or
  `Moving…`, and `close()` whether the terminal may be without a pane.
- No `exec`, `fetch`, `hc` or file access.

## Watch out

- `run()` returns `null` to mods. `terminal.park` and `terminal.keep` reply `pending: true` to
  scripts and finish in the background, so the mod watches `panes()` and `terminals()` to see them
  land instead of reading a reply. Keeping before the park lands races the core. For the same
  reason `space.new`'s ids are never seen: the mod finds the new space by comparing `spaces()`
  before and after.
- `terminal.park` also removes the `herdr.space` and `herdr.tab` labels, so `terminal.keep` has no
  memory of the old space: it puts the tab in the shown space. That is why the mod shows the
  destination before keeping, and the source again after.
- `space.new` from a mod may default to this computer rather than the focused space's machine, so
  the mod passes the source space's `machine` (`""` for this computer).
- Parking and keeping a pane alone in its tab within the same space rebuilds the same tab; only the
  repaint shows, so it reads as a reload. Hence no `New tab in this space` row for it. Moving such a
  pane to another space takes its tab with it, and can take the source space when that was its last
  tab, which is why every return to the source checks the space still exists.
- `terminal.keep` names the new tab after the terminal's address (`t4f`); `tab.rename` with an
  empty name gives it back its number.
- A mod copy's tasks end when its overlay closes, so the dialog must stay open until the keep has
  landed; closing it first strands a parked terminal. `close()` covers early closes.
- `checking()` returns early in `init`, so `herdr-app check` moves nothing and draws an empty
  dialog.
- No `setTimeout`/`setInterval`, and each `cx` stays in the task that received it.

## Done when

- `herdr-app check mods/break-pane` passes.
- In a tab with two panes, one running `echo MARKER; sleep 900`, focusing that pane and pressing
  `ctrl-space !` opens the dialog. `1` (`New tab in this space`) leaves the other pane alone in the
  tab, and a new tab in the same space shows the same terminal address with `MARKER` in its
  scrollback and `sleep` still running (`hc get <t>` shows the same pid).
- Picking another space puts the terminal in a new tab there, and the window shows the original
  space again afterwards.
- Picking `New space` makes a space named after the terminal's folder whose only tab holds the
  moved terminal; the shell `space.new` started is gone.
- Remote spaces are not offered from a local pane, and local ones not from a remote pane.
- In a one-pane tab, the dialog has no `New tab in this space` row.
- The new tab is called by its number, not the terminal address, and `herdr-app status` shows no
  overlay left open.
