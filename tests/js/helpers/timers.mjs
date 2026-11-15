/**
 * Shared deterministic timer fake for the session tests.
 *
 * `ReaderSession` owns every timer it creates, so replacing the two timer
 * globals with a queue makes readiness polling and the slow recovery loop run
 * without sleeping. The recovery loop reschedules its next sleep as soon as a
 * pass finishes, so a test that wants to change reader state between passes has
 * to use `fireNext()` (one pass per call); `runPending()` drains the whole loop.
 */

/**
 * Installs the fake. Call `restore()` when the test is done.
 *
 * @returns {{restore: () => void, pending: () => number, scheduled: () => number,
 *   fired: () => number, delays: () => number[], lastDelay: () => number|null,
 *   fireNext: () => Promise<boolean>, flush: () => Promise<void>,
 *   runPending: (limit?: number) => Promise<number>}}
 */
export function fakeTimers() {
  const real = { set: globalThis.setTimeout, clear: globalThis.clearTimeout };
  /** @type {Map<number, () => void>} */
  const queue = new Map();
  /** @type {number[]} Delay of every timer the fake was asked for, in order. */
  const delayLog = [];
  let nextId = 1;
  let firedCount = 0;

  globalThis.setTimeout = (fn, delay) => {
    const id = nextId++;
    delayLog.push(Number(delay) || 0);
    queue.set(id, typeof fn === "function" ? fn : () => {});
    return id;
  };
  globalThis.clearTimeout = (id) => {
    queue.delete(id);
  };

  /** Lets every promise the fired timer woke settle. */
  const settle = () => new Promise((resolve) => real.set(resolve, 0));

  return {
    restore() {
      globalThis.setTimeout = real.set;
      globalThis.clearTimeout = real.clear;
    },
    /** Timers waiting to run. */
    pending: () => queue.size,
    /** Timers the fake ever handed out. */
    scheduled: () => nextId - 1,
    /** Timers that already ran. */
    fired: () => firedCount,
    /** Delay of every timer requested, in the order they were requested. */
    delays: () => [...delayLog],
    /**
     * Delay of the most recent timer requested. Lets a test tell a fast pass
     * from a slow heartbeat, which the queue itself does not record.
     *
     * @returns {number|null}
     */
    lastDelay: () => (delayLog.length ? delayLog[delayLog.length - 1] : null),
    /**
     * Runs the oldest pending timer and settles what it woke.
     *
     * @returns {Promise<boolean>} False when nothing was pending.
     */
    async fireNext() {
      if (!queue.size) return false;
      const [id, fn] = queue.entries().next().value;
      queue.delete(id);
      firedCount += 1;
      fn();
      await settle();
      return true;
    },
    /**
     * Drains the queue, one timer at a time.
     *
     * @param {number} [limit] Safety valve: a loop that keeps rescheduling must
     *   not spin forever when a stop condition breaks.
     * @returns {Promise<number>} How many timers ran.
     */
    async runPending(limit = 400) {
      let rounds = 0;
      while (queue.size && rounds < limit) {
        rounds += 1;
        await this.fireNext();
      }
      return rounds;
    },
    /** Lets pending promise continuations settle without running a timer. */
    flush: settle,
  };
}
