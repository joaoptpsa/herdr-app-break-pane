# herdr-app-break-pane

A [Herdr](https://herdr.dev) desktop app mod: press `ctrl-space !` and the focused pane leaves its
tab and becomes a new tab of the same space, like tmux `break-pane`. The program in it keeps
running, with its scrollback.

Herdr has no break-pane command, so the mod runs two app commands on the focused pane's terminal:
`terminal.park` (its pane goes, the program keeps running) and then
`terminal.keep {place: "tab"}`. Nothing shows on screen while it works. A pane that is the only one
in its tab is left alone. If the terminal ends up without a pane, an error notification says so,
and clicking it gives the terminal a tab.

It makes no network requests, runs no programs and reads no files: it reads Herdr's pane, terminal
and focus lists and runs `terminal.park`, `terminal.keep` and `space.select`.

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
