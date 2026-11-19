# herdr-app-break-pane

A [Herdr](https://herdr.dev) desktop app mod: press `ctrl-space !` and the focused pane leaves its
tab and becomes a tab of its own, like tmux `break-pane`. A dialog asks where: a new tab in the
same space, another space on the same machine, or a new space in the pane's folder. Type the hint
key or click the row. The program in it keeps running, with its scrollback.

Herdr has no break-pane command, so the mod runs two app commands on the focused pane's terminal:
`terminal.park` (its pane goes, the program keeps running) and then
`terminal.keep {place: "tab"}`, then names the new tab by its number with `tab.rename`.
`terminal.keep` puts the tab in the space that is shown, so for another space the mod shows that
space, keeps the terminal there and shows the original space again; the dialog, which reads
`Moving…` until the move ends, covers the switch. For a new space it runs `space.new` in the pane's
folder, keeps the terminal there and closes the shell `space.new` started. Only spaces on the
source space's machine are offered, and the "New tab in this space" row only shows when the pane
shares its tab with another pane, since a pane alone in its tab already is a tab. If the
terminal ends up without a pane, an error notification says so, and clicking it gives the terminal
a tab.

It makes no network requests, runs no programs and reads no files: it reads Herdr's space, pane,
terminal and focus lists and runs `terminal.park`, `terminal.keep`, `space.select`, `space.new`,
`tab.rename` and `tab.close`.

## Requirements

The Herdr desktop app (`herdr-app`) 0.1.16 or later.

## Install

Copy `mods/break-pane/` into `~/.config/herdr-app/mods/`, then add the bindings from `keys.json` to
the `global` section of `~/.config/herdr-app/keys.json`. Check it loads:

```sh
herdr-app check ~/.config/herdr-app/mods/break-pane
```

`ctrl-space !` and `ctrl-space shift-1` both open it, so the binding works whichever way the
keyboard reports the shifted `1`.

`RECIPE.md` describes the mod in full, for rebuilding or changing it.

This is the desktop-app counterpart of
[joaoptpsa/herdr-break-pane](https://github.com/joaoptpsa/herdr-break-pane), the terminal herdr
plugin.

## License

MIT
