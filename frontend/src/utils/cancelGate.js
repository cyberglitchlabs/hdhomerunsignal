/**
 * Lets async work find out whether it has been superseded. start() marks the
 * beginning of a piece of work and returns isCurrent(), which turns false once
 * cancel() is called (e.g. the user moved on). Check isCurrent() after each
 * await before touching state.
 */
export function createCancelGate() {
  let generation = 0;
  return {
    cancel() {
      generation += 1;
    },
    start() {
      const mine = generation;
      return () => mine === generation;
    }
  };
}
