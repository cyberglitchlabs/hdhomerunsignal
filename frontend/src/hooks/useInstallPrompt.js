import { useEffect, useState } from 'react';

/**
 * PWA install prompt: showInstallButton says whether to offer the button and
 * install() shows the browser's prompt. The button is offered only once the
 * browser has fired beforeinstallprompt, so it is never shown where clicking
 * it could do nothing (Firefox, desktop Safari, an app that is already
 * installed). It is hidden again after the prompt is used or the app installs.
 */
export function useInstallPrompt() {
  const [deferredPrompt, setDeferredPrompt] = useState(null);

  useEffect(() => {
    const handleBeforeInstallPrompt = (e) => {
      e.preventDefault();
      setDeferredPrompt(e);
    };

    const handleAppInstalled = () => {
      setDeferredPrompt(null);
    };

    window.addEventListener('beforeinstallprompt', handleBeforeInstallPrompt);
    window.addEventListener('appinstalled', handleAppInstalled);

    return () => {
      window.removeEventListener('beforeinstallprompt', handleBeforeInstallPrompt);
      window.removeEventListener('appinstalled', handleAppInstalled);
    };
  }, []);

  const install = async () => {
    if (deferredPrompt) {
      deferredPrompt.prompt();
      const { outcome } = await deferredPrompt.userChoice;
      console.log(`User response to the install prompt: ${outcome}`);
      setDeferredPrompt(null);
    }
  };

  return { showInstallButton: deferredPrompt !== null, install };
}
