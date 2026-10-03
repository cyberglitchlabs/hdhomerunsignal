import { createInstallPromptStore } from './useInstallPrompt';

function setup() {
  const target = new EventTarget();
  const store = createInstallPromptStore(target);
  const offer = () => {
    const event = new Event('beforeinstallprompt', { cancelable: true });
    target.dispatchEvent(event);
    return event;
  };
  return { target, store, offer };
}

describe('createInstallPromptStore', () => {
  test('has no prompt until the browser offers one', () => {
    const { store } = setup();
    expect(store.getPrompt()).toBeNull();
  });

  test('keeps a prompt offered before anything subscribed, and suppresses the browser banner', () => {
    const { store, offer } = setup();
    const event = offer();
    expect(store.getPrompt()).toBe(event);
    expect(event.defaultPrevented).toBe(true);
  });

  test('notifies subscribers when a prompt arrives, and stops after unsubscribe', () => {
    const { store, offer } = setup();
    const listener = vi.fn();
    const unsubscribe = store.subscribe(listener);
    offer();
    expect(listener).toHaveBeenCalledTimes(1);

    unsubscribe();
    offer();
    expect(listener).toHaveBeenCalledTimes(1);
  });

  test('take hands the prompt over once and then it is gone', () => {
    const { store, offer } = setup();
    const event = offer();
    const listener = vi.fn();
    store.subscribe(listener);

    expect(store.take()).toBe(event);
    expect(store.getPrompt()).toBeNull();
    expect(store.take()).toBeNull();
    expect(listener).toHaveBeenCalled();
  });

  test('the prompt is dropped when the app installs', () => {
    const { target, store, offer } = setup();
    offer();
    const listener = vi.fn();
    store.subscribe(listener);

    target.dispatchEvent(new Event('appinstalled'));
    expect(store.getPrompt()).toBeNull();
    expect(listener).toHaveBeenCalledTimes(1);
  });
});
