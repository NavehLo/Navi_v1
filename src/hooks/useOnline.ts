import { useSyncExternalStore } from 'react';
import { readSimulateOffline } from '../lib/offlineMap';

// Whether the app should behave as connected. `navigator.onLine` is the
// browser's word for it; the settings screen can override it to rehearse the
// field with the network still there.

function subscribe(callback: () => void) {
  window.addEventListener('online', callback);
  window.addEventListener('offline', callback);
  return () => {
    window.removeEventListener('online', callback);
    window.removeEventListener('offline', callback);
  };
}

function read(): boolean {
  return navigator.onLine && !readSimulateOffline();
}

export function useOnline(): boolean {
  return useSyncExternalStore(subscribe, read, () => true);
}
