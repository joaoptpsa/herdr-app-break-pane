/**
 * @fileoverview Breaks the focused pane out into a new tab of its space, like
 * tmux break-pane. Herdr has no such command, so the mod parks the pane's
 * terminal (the pane goes, the program keeps running) and keeps it again as a
 * tab. mod.open shows it as a 1px frameless popup that closes itself as soon
 * as the move is done.
 */

import {View, div} from 'gpui-kit';
import {
  checking,
  closeOverlay,
  focused,
  notify,
  panes,
  props,
  run,
  terminals,
} from 'herdr';

/** How often to look for a park or keep to land, in ms. */
const POLL_INTERVAL_MS = 50;

/** Polls before a park or keep counts as failed: 5 seconds. */
const POLL_LIMIT = 100;

/**
 * Where the move stands. A terminal in PARKING or KEEPING may have no pane,
 * which leaves it running but invisible, so close() rehomes it.
 * @enum {string}
 */
const Phase = Object.freeze({
  IDLE: 'idle',
  PARKING: 'parking',
  KEEPING: 'keeping',
  DONE: 'done',
});

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
 * Explains why the focused pane can't be broken out, or returns null.
 * A pane alone in its tab already is a tab of its own: parking and keeping
 * it would rebuild the same tab, and could close its space.
 * @param {?Object} target focused()
 * @return {?string}
 */
function refusalFor(target) {
  if (!target?.pane) {
    return 'No pane has the keyboard.';
  }
  if (!target.terminal) {
    return 'The focused pane is not a terminal.';
  }
  const tabPaneCount = panes().filter((pane) => pane.tab === target.tab).length;
  if (tabPaneCount < 2) {
    return 'It is already the only pane in its tab.';
  }
  return null;
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
 * terminal address terminal.keep gives it. Returns an error message, or null.
 * @param {string} terminal
 * @return {?string}
 */
function nameTabByNumber(terminal) {
  const pane = panes().find((entry) => entry.terminal === terminal);
  if (!pane) {
    return `no pane shows ${terminal}`;
  }
  const renameError = runCaught('tab.rename', {id: pane.tab, name: ''});
  return renameError;
}

/** A one-shot action: moves the focused terminal to a new tab, then closes. */
export default class BreakPane extends View {
  /**
   * Starts the move on the focused pane, or explains why not.
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
    if (checking()) {
      return;
    }
    const target = focused();
    const refusal = refusalFor(target);
    if (refusal) {
      notify({title: 'Can\'t break pane', body: refusal, level: 'warning'});
      this.finish();
      return;
    }
    this.terminal = target.terminal;
    this.space = target.space;
    cx.spawn(async (cx) => {
      await this.breakOut(cx);
      this.finish();
    });
  }

  /**
   * Parks the terminal, then keeps it as a tab, retrying the keep once.
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
    const firstError = await this.keepAsTab(cx);
    const secondError = firstError ? await this.keepAsTab(cx) : null;
    this.phase = Phase.DONE;
    if (secondError) {
      notifyStranded(terminal, `terminal.keep failed twice: ${secondError}.`);
      return;
    }
    const renameError = nameTabByNumber(terminal);
    if (renameError) {
      notify({
        title: 'Break pane could not name the new tab',
        body: renameError,
        level: 'warning',
      });
    }
  }

  /**
   * Gives the parked terminal a new tab in the space it came from.
   * @param {!Object} cx
   * @return {!Promise<?string>} an error message, or null once it has a pane
   */
  async keepAsTab(cx) {
    const terminal = this.terminal;
    // terminal.keep places the tab in the shown space.
    if (focused()?.space !== this.space) {
      runCaught('space.select', {id: this.space});
    }
    const keepError = runCaught('terminal.keep', {terminal, place: 'tab'});
    if (keepError) {
      return keepError;
    }
    const kept = await waitFor(() => hasPane(terminal), cx);
    const timeoutError = kept ? null : 'no pane appeared';
    return timeoutError;
  }

  /** Closes this mod's popup. */
  finish() {
    const overlay = props()?.overlay;
    if (overlay) {
      closeOverlay(overlay);
    }
  }

  /**
   * Rehomes the terminal when the popup goes mid-move (Escape, a click
   * beside it), since closing cancels the move's task.
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
    const keepError = runCaught('terminal.keep', {terminal, place: 'tab'});
    if (keepError) {
      notifyStranded(terminal, `Break pane was interrupted: ${keepError}.`);
    }
  }

  /**
   * Draws nothing: the popup is 1px and frameless.
   * @return {!Object}
   */
  render() {
    return div().id('break-pane').size_full();
  }
}
