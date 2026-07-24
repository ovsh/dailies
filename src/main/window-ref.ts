/**
 * Tracks the app's single BrowserWindow so main-process code that pushes
 * events to the renderer (pipeline onUpdate, chat events, model progress)
 * never touches a destroyed window. On macOS the app keeps running after
 * the window closes, and recurring timers (queue idle poll, update
 * debounce, folder watchers) keep firing — without this guard every push
 * throws "TypeError: Object has been destroyed".
 */
export interface DestroyableWindow {
  isDestroyed(): boolean;
  on(event: "closed", listener: () => void): unknown;
}

export interface WindowRef<T extends DestroyableWindow> {
  /** Start tracking a newly created window. Returns it for chaining. */
  track(win: T): T;
  /**
   * The live window, or null when none exists. Checks isDestroyed() in
   * addition to the 'closed' event because destruction precedes the event.
   */
  get(): T | null;
}

export function createWindowRef<T extends DestroyableWindow>(): WindowRef<T> {
  let current: T | null = null;

  return {
    track(win: T): T {
      current = win;
      win.on("closed", () => {
        if (current === win) current = null;
      });
      return win;
    },
    get(): T | null {
      return current !== null && !current.isDestroyed() ? current : null;
    },
  };
}
