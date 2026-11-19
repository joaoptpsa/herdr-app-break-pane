/**
 * @fileoverview Breaks the focused pane out into a tab of its own, like tmux
 * break-pane, in its space, another space on the same machine, or a new one.
 * Herdr has no such command, so the mod parks the pane's terminal (the pane
 * goes, the program keeps running) and keeps it again as a tab. terminal.keep
 * places the tab in the shown space, so the mod shows the destination first
 * and the source again after; the dialog covers the switch.
 */

import {View, div} from 'gpui-kit';
import {h_flex, v_flex} from 'gpui-base';
import {
  checking,
  closeOverlay,
  focused,
  home,
  notify,
  panes,
  props,
  run,
  spaces,
  terminals,
  theme,
} from 'herdr';

/** How often to look for a park, keep or space switch to land, in ms. */
const POLL_INTERVAL_MS = 50;

/** Polls before a park, keep or space switch counts as failed: 5 seconds. */
const POLL_LIMIT = 100;

/**
 * Hint keys in assignment order: digits, then the Colemak-DH home row first,
 * as in pane-picker.
 */
const HINT_KEYS = '123456789arstgmneioqwfpbjluyzxcdvkh';

const CANCEL_KEYSTROKES = new Set(['escape', 'ctrl-g', 'ctrl-c']);

/**
 * Where the move stands. IDLE is the dialog waiting for a choice. A terminal
 * in PARKING or KEEPING may have no pane, which leaves it running but
 * invisible, so close() rehomes it.
 * @enum {string}
 */
const Phase = Object.freeze({
  IDLE: 'idle',
  PARKING: 'parking',
  KEEPING: 'keeping',
  DONE: 'done',
});

/**
 * Where a row sends the pane.
 * @enum {string}
 */
const DestinationKind = Object.freeze({
  TAB: 'tab',
  SPACE: 'space',
  NEW_SPACE: 'new-space',
});

/**
 * A dialog row. `space` is the space it keeps into, null for a new space.
 * @typedef {{
 *   kind: string,
 *   space: ?string,
 *   label: string,
 *   detail: string,
 *   hint: ?string,
 * }} Destination
 */

/**
 * Says whether a pane shows the terminal.
 * @param {string} terminal
 * @return {boolean}
 */
function hasPane(terminal) {
  return panes().some((pane) => pane.terminal === terminal);
}

/**
 * Says whether terminal.park has landed: no pane, and core keep is off.
 * @param {string} terminal
 * @return {boolean}
 */
function isParked(terminal) {
  const record = terminals().find((entry) => entry.address === terminal);
  const coreKeepOff = record?.keep !== true;
  return !hasPane(terminal) && coreKeepOff;
}

/**
 * Finds a space by id, or null once it is gone.
 * @param {?string} id
 * @return {?Object}
 */
function spaceById(id) {
  const space = spaces().find((entry) => entry.id === id) ?? null;
  return space;
}

/**
 * Says whether the space is the shown one.
 * @param {?string} id
 * @return {boolean}
 */
function isShown(id) {
  return focused()?.space === id;
}

/**
 * Finds the space whose tabs hold the pane showing the terminal, or null.
 * @param {string} terminal
 * @return {?Object}
 */
function spaceOfTerminal(terminal) {
  const pane = panes().find((entry) => entry.terminal === terminal);
  if (!pane) {
    return null;
  }
  const space = spaces().find(
      (entry) => entry.tabs.some((tab) => tab.id === pane.tab)) ?? null;
  return space;
}

/**
 * Returns a folder with the home directory written as ~.
 * @param {?string} folder
 * @return {string}
 */
function shortFolder(folder) {
  if (!folder) {
    return '';
  }
  const homeFolder = home();
  const insideHome = folder === homeFolder ||
      folder.startsWith(`${homeFolder}/`);
  return insideHome ? `~${folder.slice(homeFolder.length)}` : folder;
}

/**
 * Runs an app command and returns its error message, or null.
 * @param {string} name
 * @param {!Object} args
 * @return {?string}
 */
function runCaught(name, args) {
  try {
    run(name, args);
    return null;
  } catch (error) {
    const message = String(error?.message ?? error);
    return message;
  }
}

/**
 * Waits until the condition holds, polling up to POLL_LIMIT times.
 * @param {function(): boolean} condition
 * @param {!Object} cx the calling task's own context
 * @return {!Promise<boolean>} whether it held in time
 */
async function waitFor(condition, cx) {
  for (let poll = 0; poll < POLL_LIMIT; poll++) {
    if (condition()) {
      return true;
    }
    await cx.sleep(POLL_INTERVAL_MS);
  }
  const heldAtLast = condition();
  return heldAtLast;
}

/**
 * Shows the space, selecting it when another one is shown.
 * @param {string} id
 * @param {!Object} cx
 * @return {!Promise<?string>} an error message, or null once it is shown
 */
async function showSpace(id, cx) {
  if (isShown(id)) {
    return null;
  }
  const selectError = runCaught('space.select', {id});
  if (selectError) {
    return selectError;
  }
  const shown = await waitFor(() => isShown(id), cx);
  const timeoutError = shown ? null : 'it did not become the shown space';
  return timeoutError;
}

/**
 * Posts the loud warning for a terminal left without a pane; clicking it
 * runs the keep again.
 * @param {string} terminal
 * @param {string} body
 */
function notifyStranded(terminal, body) {
  notify({
    title: `Terminal ${terminal} is running without a pane`,
    body: `${body} Click here to give it a tab.`,
    level: 'error',
    action: {name: 'terminal.keep', args: {terminal, place: 'tab'}},
  });
}

/**
 * Names the terminal's tab by its number, as a new tab is, instead of the
 * terminal address terminal.keep gives it. Warns when that fails.
 * @param {string} terminal
 */
function nameTabByNumber(terminal) {
  const pane = panes().find((entry) => entry.terminal === terminal);
  const renameError = pane ?
      runCaught('tab.rename', {id: pane.tab, name: ''}) :
      `no pane shows ${terminal}`;
  if (!renameError) {
    return;
  }
  notify({
    title: 'Break pane could not name the new tab',
    body: renameError,
    level: 'warning',
  });
}

/** A dialog that moves the focused terminal to a tab where the person picks. */
export default class BreakPane extends View {
  /**
   * Captures the focused pane and takes the keyboard, or explains why not.
   * @param {?Object} _props
   * @param {!Object} cx
   */
  init(_props, cx) {
    /** @type {!Phase} */
    this.phase = Phase.IDLE;
    /** @type {?string} */
    this.terminal = null;
    /** @type {?string} */
    this.space = null;
    /** @type {?string} */
    this.tab = null;
    /** @type {?string} */
    this.cwd = null;
    /** @type {?string} the source space's machine, null for this computer */
    this.machine = null;
    /** @type {?Destination} */
    this.destination = null;
    /** @type {?string} the space the terminal is headed for, once known */
    this.destinationSpace = null;
    /** @type {!Object} */
    this.keyboard = cx.focus_handle();
    if (checking()) {
      return;
    }
    const target = focused();
    if (!target?.pane) {
      this.refuse('No pane has the keyboard.');
      return;
    }
    if (!target.terminal) {
      this.refuse('The focused pane is not a terminal.');
      return;
    }
    const pane = panes().find((entry) => entry.pane === target.pane);
    this.terminal = target.terminal;
    this.space = target.space;
    this.tab = pane?.tab ?? target.tab;
    this.cwd = target.cwd;
    this.machine = spaceById(target.space)?.machine ?? null;
    this.keyboard.focus();
    // The dialog can open before its window has keyboard focus.
    cx.timer.after(100, () => this.keyboard.focus());
  }

  /**
   * Warns why the pane can't be broken out, then closes.
   * @param {string} reason
   */
  refuse(reason) {
    notify({title: 'Can\'t break pane', body: reason, level: 'warning'});
    this.finish();
  }

  /**
   * Lists where the pane can go, each with its hint key. Both the rows and
   * the key handler read this, so a hint always picks the row it labels.
   * @return {!Array<!Destination>}
   */
  destinations() {
    if (!this.terminal) {
      return [];
    }
    const tabPaneCount = panes().filter((pane) => pane.tab === this.tab).length;
    const others = spaces().filter((space) =>
      space.id !== this.space && (space.machine ?? null) === this.machine);
    const rows = [];
    // A pane alone in its tab already is a tab.
    if (tabPaneCount >= 2) {
      rows.push({
        kind: DestinationKind.TAB,
        space: this.space,
        label: 'New tab in this space',
        detail: '',
      });
    }
    for (const space of others) {
      rows.push({
        kind: DestinationKind.SPACE,
        space: space.id,
        label: space.name,
        detail: shortFolder(space.folder),
      });
    }
    rows.push({
      kind: DestinationKind.NEW_SPACE,
      space: null,
      label: 'New space',
      detail: '',
    });
    const hinted = rows.map((row, index) => ({
      ...row,
      hint: HINT_KEYS[index] ?? null,
    }));
    return hinted;
  }

  /**
   * Starts the move to the picked destination; the dialog shows Moving…
   * until it ends, then closes.
   * @param {!Destination} destination
   * @param {!Object} cx
   */
  pick(destination, cx) {
    if (this.phase !== Phase.IDLE) {
      return;
    }
    this.destination = destination;
    this.destinationSpace = destination.space;
    this.phase = Phase.PARKING;
    cx.notify();
    cx.spawn(async (cx) => {
      await this.breakOut(cx);
      this.finish();
    });
  }

  /**
   * Parks the terminal, then keeps it as a tab where the destination says.
   * @param {!Object} cx
   * @return {!Promise<void>}
   */
  async breakOut(cx) {
    const terminal = this.terminal;
    this.phase = Phase.PARKING;
    const parkError = runCaught('terminal.park', {terminal});
    if (parkError) {
      this.phase = Phase.DONE;
      notify({title: 'Can\'t break pane', body: parkError, level: 'error'});
      return;
    }
    const parked = await waitFor(() => isParked(terminal), cx);
    if (!parked && hasPane(terminal)) {
      this.phase = Phase.DONE;
      notify({
        title: 'Can\'t break pane',
        body: `Herdr did not park ${terminal}; it stays where it was.`,
        level: 'error',
      });
      return;
    }

    this.phase = Phase.KEEPING;
    switch (this.destination.kind) {
      case DestinationKind.TAB:
        await this.moveToSourceTab(cx);
        break;
      case DestinationKind.SPACE:
        await this.moveToSpace(this.destination, cx);
        break;
      case DestinationKind.NEW_SPACE:
        await this.moveToNewSpace(cx);
        break;
    }
    this.phase = Phase.DONE;
  }

  /**
   * Keeps the parked terminal as a new tab of the space it came from.
   * @param {!Object} cx
   * @return {!Promise<void>}
   */
  async moveToSourceTab(cx) {
    const keepError = await this.keepTwice(this.space, cx);
    if (keepError) {
      notifyStranded(this.terminal, `terminal.keep failed twice: ${keepError}.`);
      return;
    }
    this.phase = Phase.DONE;
    nameTabByNumber(this.terminal);
  }

  /**
   * Shows another space, keeps the parked terminal there, then shows the
   * source space again when it still exists.
   * @param {!Destination} destination
   * @param {!Object} cx
   * @return {!Promise<void>}
   */
  async moveToSpace(destination, cx) {
    const terminal = this.terminal;
    if (!spaceById(destination.space)) {
      await this.keepAtSource(`The space ${destination.label} is gone.`, cx);
      return;
    }
    const showError = await showSpace(destination.space, cx);
    if (showError) {
      await this.keepAtSource(
          `Could not show ${destination.label}: ${showError}.`, cx);
      return;
    }
    const keepError = await this.keepTwice(destination.space, cx);
    if (keepError) {
      notifyStranded(terminal, `terminal.keep failed twice: ${keepError}.`);
      return;
    }
    this.phase = Phase.DONE;
    nameTabByNumber(terminal);
    this.returnToSource();
    const landed = spaceOfTerminal(terminal);
    if (landed?.id === destination.space) {
      return;
    }
    notify({
      title: `Break pane did not reach ${destination.label}`,
      body: `${terminal} landed in ${landed?.name ?? 'an unknown space'}.`,
      level: 'warning',
    });
  }

  /**
   * Makes a space in the terminal's folder, keeps the parked terminal there
   * and closes the shell that space.new started with it.
   * @param {!Object} cx
   * @return {!Promise<void>}
   */
  async moveToNewSpace(cx) {
    const terminal = this.terminal;
    const before = new Set(spaces().map((space) => space.id));
    const findCreated = () => spaces().find(
        (space) => !before.has(space.id) && space.tabs.length > 0);
    const args = {focus: true, machine: this.machine ?? ''};
    if (this.cwd) {
      args.folder = this.cwd;
    }
    const newError = runCaught('space.new', args);
    if (newError) {
      await this.keepAtSource(`space.new failed: ${newError}.`, cx);
      return;
    }
    // run() returns null to mods, so the new space is the one not seen before.
    await waitFor(() => Boolean(findCreated()), cx);
    const created = findCreated();
    if (!created) {
      await this.keepAtSource('No new space appeared after space.new.', cx);
      return;
    }
    this.destinationSpace = created.id;
    const shellTab = created.tabs[0].id;
    const showError = await showSpace(created.id, cx);
    if (showError) {
      await this.keepAtSource(
          `Could not show the new space: ${showError}.`, cx);
      this.closeTab(shellTab);
      return;
    }
    const keepError = await this.keepTwice(created.id, cx);
    if (keepError) {
      notifyStranded(terminal, `terminal.keep failed twice: ${keepError}.`);
      return;
    }
    this.phase = Phase.DONE;
    nameTabByNumber(terminal);
    this.closeTab(shellTab);
    this.returnToSource();
  }

  /**
   * Keeps the parked terminal in its source space after the destination
   * failed, or in the shown space when the source is gone too.
   * @param {string} reason
   * @param {!Object} cx
   * @return {!Promise<void>}
   */
  async keepAtSource(reason, cx) {
    const terminal = this.terminal;
    this.destinationSpace = this.space;
    const keepError = await this.keepTwice(this.space, cx);
    if (keepError) {
      notifyStranded(terminal, `${reason} terminal.keep failed: ${keepError}.`);
      return;
    }
    this.phase = Phase.DONE;
    nameTabByNumber(terminal);
    const landed = spaceOfTerminal(terminal);
    notify({
      title: 'Break pane could not reach its destination',
      body: `${reason} ${terminal} has a new tab in ` +
          `${landed?.name ?? 'the shown space'} instead.`,
      level: 'warning',
    });
  }

  /**
   * Keeps the parked terminal as a tab in a space, retrying once.
   * @param {?string} space the space to keep in; the shown one once it's gone
   * @param {!Object} cx
   * @return {!Promise<?string>} the second error, or null once it has a pane
   */
  async keepTwice(space, cx) {
    const firstError = await this.keepAsTab(space, cx);
    const secondError = firstError ? await this.keepAsTab(space, cx) : null;
    return secondError;
  }

  /**
   * Gives the parked terminal a new tab in the space, or in the shown space
   * once that space is gone.
   * @param {?string} space
   * @param {!Object} cx
   * @return {!Promise<?string>} an error message, or null once it has a pane
   */
  async keepAsTab(space, cx) {
    const terminal = this.terminal;
    // terminal.keep places the tab in the shown space.
    const showError = spaceById(space) ? await showSpace(space, cx) : null;
    if (showError) {
      return `could not show ${space}: ${showError}`;
    }
    const keepError = runCaught('terminal.keep', {terminal, place: 'tab'});
    if (keepError) {
      return keepError;
    }
    const kept = await waitFor(() => hasPane(terminal), cx);
    const timeoutError = kept ? null : 'no pane appeared';
    return timeoutError;
  }

  /**
   * Shows the source space again when it still exists. When the move took
   * its last tab, it is gone and the window stays where the terminal went.
   */
  returnToSource() {
    if (!spaceById(this.space) || isShown(this.space)) {
      return;
    }
    const selectError = runCaught('space.select', {id: this.space});
    if (!selectError) {
      return;
    }
    notify({
      title: 'Break pane could not show the original space again',
      body: selectError,
      level: 'warning',
    });
  }

  /**
   * Closes the tab space.new started, ending its shell, unless the moved
   * terminal is in it.
   * @param {string} tab
   */
  closeTab(tab) {
    const movedTab = panes().find((pane) => pane.terminal === this.terminal)?.tab;
    if (tab === movedTab) {
      return;
    }
    const closeError = runCaught('tab.close', {id: tab, confirmed: true});
    if (!closeError) {
      return;
    }
    notify({
      title: 'Break pane could not close the new space\'s shell',
      body: closeError,
      level: 'warning',
    });
  }

  /** Closes this mod's dialog. */
  finish() {
    const overlay = props()?.overlay;
    if (overlay) {
      closeOverlay(overlay);
    }
  }

  /**
   * Rehomes the terminal when the dialog goes mid-move (Escape, a click
   * beside it, the binding again), since closing cancels the move's task.
   * Prefers the destination space, else the shown one.
   * @param {!Object} _cx
   * @return {!Promise<void>}
   */
  async close(_cx) {
    const interrupted = this.phase === Phase.PARKING ||
        this.phase === Phase.KEEPING;
    if (!interrupted) {
      return;
    }
    this.phase = Phase.DONE;
    const terminal = this.terminal;
    if (hasPane(terminal)) {
      notifyStranded(terminal, 'Break pane was interrupted mid-park.');
      return;
    }
    const destination = this.destinationSpace;
    if (spaceById(destination) && !isShown(destination)) {
      runCaught('space.select', {id: destination});
    }
    const keepError = runCaught('terminal.keep', {terminal, place: 'tab'});
    if (keepError) {
      notifyStranded(terminal, `Break pane was interrupted: ${keepError}.`);
    }
  }

  /**
   * Picks the row whose hint was typed, or cancels. Keys do nothing while
   * the move runs.
   * @param {!Object} event
   * @param {!Object} cx
   */
  onKeyDown(event, cx) {
    cx.stop_propagation();
    if (this.phase !== Phase.IDLE) {
      return;
    }
    if (CANCEL_KEYSTROKES.has(event.keystroke)) {
      this.finish();
      return;
    }
    const match = this.destinations().find(
        ({hint}) => hint === event.keystroke);
    if (match) {
      this.pick(match, cx);
    }
  }

  /**
   * Draws one destination's row: hint, label and dim detail.
   * @param {!Destination} destination
   * @param {!Object} colors
   * @return {!Object}
   */
  row(destination, colors) {
    const {hint, label, detail} = destination;
    const badge = div()
        .w(22).h(22).flex_none().rounded(5)
        .flex().items_center().justify_center()
        .bg(hint ? colors.accent : colors.raised)
        .text_color(colors.accent_foreground)
        .font_bold()
        .child(hint ?? '·');
    return h_flex()
        .id(`break-pane-${destination.kind}-${destination.space ?? ''}`)
        .px(10).h(34).gap(10).items_center().rounded(7)
        .cursor_pointer()
        .hover((style) => style.bg(colors.hover))
        .active((style) => style.bg(colors.selected))
        .on_click((_event, cx) => this.pick(destination, cx))
        .child(badge)
        .child(div()
            .flex_1().truncate()
            .text_color(colors.foreground)
            .child(label))
        .child(div().truncate().text_size(11).text_color(colors.dim)
            .child(detail));
  }

  /**
   * @override
   * @return {!Object}
   */
  render() {
    const colors = theme();
    const moving = this.phase !== Phase.IDLE;
    const body = moving ?
        [div().px(10).h(34).flex().items_center()
            .text_color(colors.dim)
            .child('Moving…')] :
        this.destinations().map((destination) => this.row(destination, colors));
    return v_flex()
        .id('break-pane')
        .track_focus(this.keyboard)
        .on_key_down((event, cx) => this.onKeyDown(event, cx))
        .w_full().p(14).gap(4)
        .bg(colors.popover)
        .text_size(13)
        .child(div()
            .pb(6).text_size(15).font_semibold()
            .text_color(colors.foreground)
            .child('Break pane to'))
        .children(body);
  }
}
