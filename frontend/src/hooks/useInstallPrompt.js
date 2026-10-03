import { useSyncExternalStore } from 'react';

/**
 * Holds the browser's install prompt. The browser fires beforeinstallprompt
 * once, possibly before any component has mounted, so this listens from the
 * moment the module loads and the hook reads what it caught. The prompt is
 * dropped once it is used or the app installs.
 */
export function createInstallPromptStore(target) {
  let prompt = null;
  const listeners = new Set();
  const notify = () => listeners.forEach((listener) => listener());

  target.addEventListener('beforeinstallprompt', (e) => {
    e.preventDefault();
    prompt = e;
    notify();
  });
  target.addEventListener('appinstalled', () => {
    prompt = null;
    notify();
  });

  return {
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    getPrompt: () => prompt,
    // Hand the prompt over exactly once; a prompt can only be shown once
    take() {
      const taken = prompt;
      prompt = null;
      notify();
      return taken;
    }
  };
}

const store = createInstallPromptStore(typeof window === 'undefined' ? new EventTarget() : window);

/**
 * PWA install prompt: showInstallButton says whether to offer the button and
 * install() shows the browser's prompt. The button is offered only once the
 * browser has offered a prompt, so it is never shown where clicking it could
 * do nothing (Firefox, desktop Safari, an app that is already installed).
 */
export function useInstallPrompt() {
  const prompt = useSyncExternalStore(store.subscribe, store.getPrompt);

  const install = async () => {
    const taken = store.take();
    if (!taken) return;
    try {
      taken.prompt();
      const { outcome } = await taken.userChoice;
      console.log(`User response to the install prompt: ${outcome}`);
    } catch (error) {
      console.error('Install prompt failed:', error);
    }
  };

  return { showInstallButton: prompt !== null, install };
}
