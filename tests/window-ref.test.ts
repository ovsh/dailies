import { describe, expect, it } from "vitest";
import { createWindowRef, type DestroyableWindow } from "../src/main/window-ref";

/**
 * Regression for the macOS close-window crash: recurring main-process timers
 * (queue idle poll, update debounce, folder watchers) kept calling onUpdate
 * against a destroyed BrowserWindow — "TypeError: Object has been destroyed"
 * on every tick. winRef.get() must return null the moment the window is
 * destroyed, even before the 'closed' event fires.
 */

class FakeWindow implements DestroyableWindow {
  destroyed = false;
  private closedListeners: Array<() => void> = [];

  isDestroyed(): boolean {
    return this.destroyed;
  }

  on(event: "closed", listener: () => void): void {
    if (event === "closed") this.closedListeners.push(listener);
  }

  /** Mirrors Electron ordering: destruction happens, then 'closed' fires. */
  close(): void {
    this.destroyed = true;
    for (const listener of this.closedListeners) listener();
  }
}

describe("createWindowRef", () => {
  it("returns null before any window is tracked", () => {
    expect(createWindowRef().get()).toBeNull();
  });

  it("returns the tracked window while it is alive", () => {
    const ref = createWindowRef<FakeWindow>();
    const win = new FakeWindow();
    expect(ref.track(win)).toBe(win);
    expect(ref.get()).toBe(win);
  });

  it("returns null once the window is destroyed, even before 'closed' fires", () => {
    const ref = createWindowRef<FakeWindow>();
    const win = ref.track(new FakeWindow());
    win.destroyed = true;
    expect(ref.get()).toBeNull();
  });

  it("returns null after the window closes", () => {
    const ref = createWindowRef<FakeWindow>();
    const win = ref.track(new FakeWindow());
    win.close();
    expect(ref.get()).toBeNull();
  });

  it("tracks a replacement window after the previous one closed", () => {
    const ref = createWindowRef<FakeWindow>();
    ref.track(new FakeWindow()).close();
    const second = ref.track(new FakeWindow());
    expect(ref.get()).toBe(second);
  });

  it("keeps the replacement when the stale window's 'closed' fires late", () => {
    const ref = createWindowRef<FakeWindow>();
    const first = new FakeWindow();
    ref.track(first);
    const second = ref.track(new FakeWindow());
    first.close();
    expect(ref.get()).toBe(second);
  });
});
