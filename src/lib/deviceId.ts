// A random id this device makes for itself, the first time it is asked, and
// keeps in localStorage. Not a hardware id: clearing the app's data makes a
// new one. It tells one guest apart from another in the admin's usage report,
// marks the admin's own devices (so their use is left out of it), and limits
// the help chat per device.

const DEVICE_KEY = "navi:device.v1";

export function deviceId(): string | undefined {
  try {
    let id = localStorage.getItem(DEVICE_KEY);
    if (!id) {
      id = crypto.randomUUID();
      localStorage.setItem(DEVICE_KEY, id);
    }
    return id;
  } catch {
    return undefined;
  }
}
