// What a newcomer has already been shown: the welcome tour, the tour of the
// trail screen, and the one-off tips. Each is shown once and then remembered on
// the device, so it never comes back by itself — only from "מדריכים ומידע נוסף" in the
// settings.
//
// Blocked storage reads as "seen". The alternative is a tour that pops up on
// every single visit, which is worse than no tour at all.

export type HelpKey = 'welcome' | 'trail' | 'tracking' | 'drive';

const PREFIX = 'navi:seen:';
const ALL: HelpKey[] = ['welcome', 'trail', 'tracking', 'drive'];

export function hasSeen(key: HelpKey): boolean {
  try {
    return localStorage.getItem(PREFIX + key) === '1';
  } catch {
    return true;
  }
}

export function markSeen(key: HelpKey) {
  try { localStorage.setItem(PREFIX + key, '1'); } catch {}
}

export function resetOnboarding() {
  try {
    for (const key of ALL) localStorage.removeItem(PREFIX + key);
  } catch {}
}
