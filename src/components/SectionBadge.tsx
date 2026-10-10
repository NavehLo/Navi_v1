import { Sparkles } from 'lucide-react';

// A popular part of a long trail (lib/trailCrowd/sections.ts) — a famous day
// walk on the Peaks of the Balkans or the West Highland Way — stands out in
// every list and on its card: for a day out it matters more than the long
// trail it belongs to.
const OF_GROUP: Record<string, string> = {
  INT: 'משביל בינלאומי',
  NAT: 'משביל לאומי',
  REG: 'משביל אזורי',
};

export function sectionLabel(parentGroup: string | undefined): string {
  return `קטע פופולרי ${OF_GROUP[parentGroup ?? ''] ?? 'משביל ארוך'}`;
}

export default function SectionBadge({ parentGroup, parentName }: { parentGroup?: string; parentName?: string | null }) {
  return (
    <span className="self-start inline-flex items-center gap-1 rounded-full bg-amber-300 text-zinc-950 px-2 py-0.5 text-xs font-extrabold">
      <Sparkles className="w-3.5 h-3.5 shrink-0" />
      {sectionLabel(parentGroup)}
      {parentName && <>: <bdi>{parentName}</bdi></>}
    </span>
  );
}
