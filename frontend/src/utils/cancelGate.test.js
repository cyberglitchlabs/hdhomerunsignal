import { createCancelGate } from './cancelGate';

describe('createCancelGate', () => {
  test('work is current until the gate is cancelled', () => {
    const gate = createCancelGate();
    const isCurrent = gate.start();
    expect(isCurrent()).toBe(true);
    gate.cancel();
    expect(isCurrent()).toBe(false);
  });

  test('cancelling does not affect work started afterwards', () => {
    const gate = createCancelGate();
    const first = gate.start();
    gate.cancel();
    const second = gate.start();
    expect(first()).toBe(false);
    expect(second()).toBe(true);
  });

  test('work that has been cancelled stays cancelled', () => {
    const gate = createCancelGate();
    const isCurrent = gate.start();
    gate.cancel();
    gate.start();
    expect(isCurrent()).toBe(false);
  });

  test('cancel covers every piece of work in flight', () => {
    const gate = createCancelGate();
    const a = gate.start();
    const b = gate.start();
    gate.cancel();
    expect([a(), b()]).toEqual([false, false]);
  });
});
