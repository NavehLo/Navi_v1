// The shape of /api/admin/users-report's answer, shared with the admin's
// "משתמשים ושימוש" screen (UsersReportPanel).

export interface ApiUse {
  provider: string;
  calls: number;
  chars: number;
  searches: number;
  costUsd: number;
}

export interface PersonUsage {
  key: string;
  kind: 'user' | 'guest';
  email: string | null;
  // "אורח 3", numbered by when each guest was first seen.
  guestNo?: number;
  signedUpAt: string | null;
  lastSignInAt: string | null;
  firstAt: string | null;
  lastAt: string | null;
  activeDays: number;
  native: boolean;
  web: boolean;
  events: Record<string, number>;
  eventsTotal: number;
  api: ApiUse[];
  apiCalls: number;
  costUsd: number;
}

export interface EventUsage {
  event: string;
  count: number;
  people: number;
}

export interface ProviderUsage extends ApiUse {
  people: number;
}

export interface OwnerDevice {
  id: string;
  label: string | null;
  createdAt: string;
  current: boolean;
}

export interface OwnerExclusion {
  devices: OwnerDevice[];
  ips: Array<{ ip: string; label: string | null; createdAt: string }>;
  // The IP the admin's screen is asking from, to add with one tap.
  currentIp: string | null;
}

export type UsersReport =
  | { status: 'not-configured' | 'no-table' | 'error'; detail?: string; owner?: OwnerExclusion }
  | {
      status: 'ok';
      days: number;
      eventsSince: string | null;
      apiSince: string | null;
      summary: {
        registered: number;
        newRegistered: number;
        activeRegistered: number;
        activeGuests: number;
        nativePeople: number;
        events: number;
        apiCalls: number;
        costUsd: number;
      };
      people: PersonUsage[];
      byEvent: EventUsage[];
      byProvider: ProviderUsage[];
      owner: OwnerExclusion;
      // How much of the admin's own use was left out, so it is seen to work.
      excluded: { events: number; apiCalls: number };
    };
