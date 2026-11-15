/**
 * Zoom and rotation watcher for one pdf.js viewer realm.
 *
 * The pdf.js event names changed over time, so every name is subscribed
 * defensively and unknown names are simply ignored. Callbacks are debounced:
 * a slider drag fires many events and only the last geometry matters.
 */

import { warnOnce } from "./overlay.js";

/** Default debounce for a zoom burst, in milliseconds. */
export const DEBOUNCE_MS = 150;

/** Scale event names tried on the event bus. */
export const SCALE_EVENTS = ["scalechanging", "scalechange"];

/** Rotation event names tried on the event bus. */
export const ROTATION_EVENTS = ["rotationchanging", "rotation"];

/**
 * Subscribes to scale and rotation changes with a trailing debounce.
 *
 * @param {object} input
 * @param {object} input.eventBus A pdf.js event bus, may be null.
 * @param {(event: object, name: string) => void} input.onChange
 * @param {number} [input.delay]
 * @param {Set} [input.timers] Timer set owned by the caller, so a session can
 *   cancel pending work as a whole.
 * @returns {{destroy: () => void}}
 */
export function createZoomWatcher({ eventBus, onChange, delay = DEBOUNCE_MS, timers }) {
  const owned = timers instanceof Set ? timers : new Set();
  const subscriptions = [];
  let timer = null;

  const schedule = (event, name) => {
    if (timer !== null) {
      clearTimeout(timer);
      owned.delete(timer);
    }
    timer = setTimeout(() => {
      owned.delete(timer);
      timer = null;
      try {
        onChange?.(event, name);
      } catch (err) {
        warnOnce("zoom-callback", err);
      }
    }, delay);
    owned.add(timer);
  };

  const handler = (event) => {
    try {
      schedule(event, event?.type ?? "viewchange");
    } catch (err) {
      warnOnce("zoom-schedule", err);
    }
  };

  for (const name of [...SCALE_EVENTS, ...ROTATION_EVENTS]) {
    try {
      eventBus?.on?.(name, handler);
      subscriptions.push({ name, handler });
    } catch (err) {
      // Unknown event name on this pdf.js version: try the next one.
      warnOnce(`zoom-subscribe:${name}`, err);
    }
  }

  return {
    destroy() {
      if (timer !== null) {
        clearTimeout(timer);
        owned.delete(timer);
        timer = null;
      }
      for (const { name, handler: fn } of subscriptions) {
        try {
          eventBus?.off?.(name, fn);
        } catch (err) {
          warnOnce(`zoom-unsubscribe:${name}`, err);
        }
      }
      subscriptions.length = 0;
    },
  };
}
