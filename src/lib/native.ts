import { Capacitor, registerPlugin, type PluginListenerHandle } from '@capacitor/core';

// The Android app (android-app/) is a thin shell that opens this same site,
// plus two things a website cannot do on a phone: follow the GPS with the
// screen off, and sound an alarm from the lock screen. Chrome stops giving a
// page its location the moment the screen goes dark; the app keeps a small
// "Navi is following the trail" notification up instead, and while it is
// there the location keeps coming and this page keeps running.
//
// In a browser none of this exists and every function here says so — the
// site works as before.

export const isNativeApp = (): boolean => {
  try { return Capacitor.isNativePlatform(); } catch { return false; }
};

// ── GPS that keeps going with the screen off ─────────────────────────────────
// @capacitor-community/background-geolocation

interface BgLocation { latitude: number; longitude: number; accuracy: number }
interface BgError { code?: string; message: string }
interface BackgroundGeolocationPlugin {
  addWatcher(
    options: {
      backgroundTitle?: string;
      backgroundMessage?: string;
      requestPermissions?: boolean;
      stale?: boolean;
      distanceFilter?: number;
    },
    callback: (position?: BgLocation, error?: BgError) => void
  ): Promise<string>;
  removeWatcher(options: { id: string }): Promise<void>;
  openSettings(): Promise<void>;
}
const BackgroundGeolocation = registerPlugin<BackgroundGeolocationPlugin>('BackgroundGeolocation');

export type NativeFix = { lat: number; lon: number; accuracy: number | null };

// Starts following the phone; returns the function that stops it (and takes
// the notification away).
export function watchNativePosition(
  onFix: (fix: NativeFix) => void,
  onError: (message: string, needsSettings: boolean) => void
): () => void {
  let id: string | null = null;
  let stopped = false;
  // The notification that keeps the location coming needs the notification
  // permission on Android 13+; ask first, so both prompts come together.
  void ensureNotificationPermission().finally(() => {
    if (stopped) return;
    BackgroundGeolocation.addWatcher(
      {
        backgroundTitle: 'Navi עוקבת אחרי המסלול',
        backgroundMessage: 'המיקום נמדד גם כשהמסך כבוי — להתראת סטייה ולמדריכה.',
        requestPermissions: true,
        stale: false,
        distanceFilter: 5,
      },
      (loc, err) => {
        if (err) {
          const denied = err.code === 'NOT_AUTHORIZED';
          onError(denied ? 'אין הרשאת מיקום לאפליקציה.' : err.message, denied);
          return;
        }
        if (loc) onFix({ lat: loc.latitude, lon: loc.longitude, accuracy: Number.isFinite(loc.accuracy) ? loc.accuracy : null });
      }
    ).then((watcherId) => {
      if (stopped) void BackgroundGeolocation.removeWatcher({ id: watcherId });
      else id = watcherId;
    }).catch((e) => onError(String(e?.message ?? e), false));
  });
  return () => {
    stopped = true;
    if (id) void BackgroundGeolocation.removeWatcher({ id });
  };
}

export function openAppSettings() {
  void BackgroundGeolocation.openSettings().catch(() => {});
}

// ── The alarm, as a notification ─────────────────────────────────────────────
// @capacitor/local-notifications. A notification channel of the highest
// importance, with the siren (android-app/.../res/raw/siren.wav) as its sound:
// it sounds and vibrates on the lock screen, where page audio cannot.

interface LocalNotificationsPlugin {
  createChannel(channel: {
    id: string; name: string; description?: string; importance: 1 | 2 | 3 | 4 | 5;
    visibility?: -1 | 0 | 1; sound?: string; vibration?: boolean; lights?: boolean; lightColor?: string;
  }): Promise<void>;
  checkPermissions(): Promise<{ display: string }>;
  requestPermissions(): Promise<{ display: string }>;
  schedule(options: { notifications: Array<{
    id: number; title: string; body: string; channelId?: string; sound?: string; autoCancel?: boolean; ongoing?: boolean;
  }> }): Promise<unknown>;
  cancel(options: { notifications: Array<{ id: number }> }): Promise<void>;
  addListener(event: 'localNotificationActionPerformed', cb: () => void): Promise<PluginListenerHandle>;
}
const LocalNotifications = registerPlugin<LocalNotificationsPlugin>('LocalNotifications');

// A channel's sound cannot be changed once it exists; a new sound means a new id.
const ALARM_CHANNEL = 'offroute-siren-v1';
const ALARM_ID = 7001;
let channelReady: Promise<void> | null = null;

async function ensureNotificationPermission() {
  if (!isNativeApp()) return;
  try {
    const { display } = await LocalNotifications.checkPermissions();
    if (display !== 'granted') await LocalNotifications.requestPermissions();
  } catch {}
}

function ensureAlarmChannel(): Promise<void> {
  if (!channelReady) {
    channelReady = LocalNotifications.createChannel({
      id: ALARM_CHANNEL,
      name: 'התראת סטייה מהמסלול',
      description: 'צליל חזק כשמתרחקים מהמסלול',
      importance: 5,
      visibility: 1,
      sound: 'siren.wav',
      vibration: true,
      lights: true,
      lightColor: '#FF0000',
    }).catch(() => {});
  }
  return channelReady;
}

export function prepareNativeAlarm() {
  if (!isNativeApp()) return;
  void ensureAlarmChannel();
  void ensureNotificationPermission();
}

export async function showNativeAlarm(body: string) {
  await ensureAlarmChannel();
  try {
    // Cancelled first so that posting it again sounds again, rather than
    // quietly updating the one already there.
    await LocalNotifications.cancel({ notifications: [{ id: ALARM_ID }] });
    await LocalNotifications.schedule({
      notifications: [{ id: ALARM_ID, title: 'סטית מהמסלול', body, channelId: ALARM_CHANNEL, sound: 'siren.wav', autoCancel: true }],
    });
  } catch {}
}

export function clearNativeAlarm() {
  if (!isNativeApp()) return;
  void LocalNotifications.cancel({ notifications: [{ id: ALARM_ID }] }).catch(() => {});
}

// Tapping the notification is also "I have heard it".
export function onNativeAlarmTapped(cb: () => void): () => void {
  if (!isNativeApp()) return () => {};
  let handle: PluginListenerHandle | null = null;
  let gone = false;
  LocalNotifications.addListener('localNotificationActionPerformed', cb)
    .then((h) => { if (gone) void h.remove(); else handle = h; })
    .catch(() => {});
  return () => { gone = true; void handle?.remove(); };
}

// ── Signing in with Google from the app ──────────────────────────────────────
// Google refuses to sign anyone in inside an app's embedded browser
// ("disallowed_useragent"). So in the app the sign-in page opens in Chrome
// (a Custom Tab, @capacitor/browser), and when it is done Supabase sends the
// browser to this app-only address, which Android hands back to the app
// (@capacitor/app, "appUrlOpen"). The address must be listed in Supabase →
// Authentication → URL Configuration → Redirect URLs.

export const NATIVE_AUTH_REDIRECT = 'app.navi.trails://auth-callback';

interface BrowserPlugin { open(o: { url: string }): Promise<void>; close(): Promise<void> }
interface AppPlugin { addListener(e: 'appUrlOpen', cb: (d: { url: string }) => void): Promise<PluginListenerHandle> }
const Browser = registerPlugin<BrowserPlugin>('Browser');
const App = registerPlugin<AppPlugin>('App');

export async function openInSystemBrowser(url: string) {
  await Browser.open({ url });
}

// Calls back with the sign-in result the browser returned to the app.
export function onNativeAuthRedirect(cb: (url: URL) => void): () => void {
  if (!isNativeApp()) return () => {};
  let handle: PluginListenerHandle | null = null;
  let gone = false;
  App.addListener('appUrlOpen', ({ url }) => {
    if (!url.startsWith(NATIVE_AUTH_REDIRECT)) return;
    void Browser.close().catch(() => {});
    try { cb(new URL(url)); } catch {}
  }).then((h) => { if (gone) void h.remove(); else handle = h; }).catch(() => {});
  return () => { gone = true; void handle?.remove(); };
}
