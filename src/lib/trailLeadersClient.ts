import { useEffect, useState } from 'react';
import type { CountryLeaders } from './trailCrowd/leaders';

// The leading trails of every collected country (api/world-trails/leaders),
// fetched once a session and shared by the country picker and the map.

let memo: Record<string, CountryLeaders> | null = null;
let pending: Promise<Record<string, CountryLeaders>> | null = null;

export function fetchLeaders(): Promise<Record<string, CountryLeaders>> {
  if (memo) return Promise.resolve(memo);
  pending ??= fetch('/api/world-trails/leaders')
    .then((r) => r.json())
    .then((d) => {
      memo = d.status === 'ok' ? d.countries ?? {} : {};
      return memo!;
    })
    .catch(() => {
      pending = null; // another try next time
      return {};
    });
  return pending;
}

export function useLeaders(active = true): Record<string, CountryLeaders> {
  const [leaders, setLeaders] = useState<Record<string, CountryLeaders>>(memo ?? {});
  useEffect(() => {
    if (!active || memo) return;
    let live = true;
    fetchLeaders().then((l) => { if (live) setLeaders(l); });
    return () => { live = false; };
  }, [active]);
  return memo ?? leaders;
}
