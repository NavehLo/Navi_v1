// What a help-chat answer may offer as a button: a fixed list, so the model
// can only point at places that exist. Each id is wired to the screen in
// page.tsx; the model picks from the ones that fit the screen as it is (with a
// trail open or not), and the chat checks again before drawing a button.

// The few facts about the screen sent with each question — enough to answer
// "where is it" correctly, nothing about the user or the trail itself.
export interface HelpScreen {
  hasTrail: boolean;
  // The open trail is a drive: no guide points there.
  driveTrail: boolean;
  mode: 'trails' | 'drive';
  recording: boolean;
  nativeApp: boolean;
  inIsrael: boolean;
  // The names under the rail buttons are shown ("הסתר שמות" hides them, and
  // then only the icons tell the buttons apart).
  labelsOn: boolean;
}

type Needs = 'trail' | 'noTrail' | 'any';

export const HELP_ACTIONS = {
  openDiscovery: { label: 'פתח את רשימת המסלולים', needs: 'noTrail', about: 'רשימת המסלולים עם חיפוש וסינון, כולל לשונית "מסלולים בעולם"' },
  openWorldTrails: { label: 'הצג מסלולים בעולם על המפה', needs: 'any', about: 'שכבת המסלולים המסומנים מכל העולם על המפה' },
  openDrive: { label: 'פתח נסיעה ברכב', needs: 'noTrail', about: 'תכנון נסיעה בכביש' },
  planRoute: { label: 'פתח תכנון מסלול', needs: 'any', about: 'תכנון מסלול הליכה בין נקודות' },
  locate: { label: 'הצג את המיקום שלי', needs: 'any', about: 'המיקום החי על המפה' },
  record: { label: 'התחל הקלטה', needs: 'any', about: 'הקלטת ההליכה' },
  openGuidePoints: { label: 'פתח את הנקודות', needs: 'trail', about: 'נקודות המדריכה והורדת המסלול לשטח' },
  startVirtualTour: { label: 'התחל סיור וירטואלי', needs: 'trail', about: 'טיסה לאורך המסלול הפתוח' },
  openSettings: { label: 'פתח הגדרות', needs: 'any', about: 'ההגדרות: התחברות, התראת סטייה, הסבר על כל האפשרויות' },
  openRecordings: { label: 'פתח את ההקלטות שלי', needs: 'any', about: 'ההקלטות השמורות' },
  showTour: { label: 'הצג את ההדרכה של המסך הזה', needs: 'any', about: 'הסיור הקצר שמסביר את המסך' },
} as const satisfies Record<string, { label: string; needs: Needs; about: string }>;

export type HelpActionId = keyof typeof HELP_ACTIONS;

export function availableActions(screen: HelpScreen): HelpActionId[] {
  return (Object.keys(HELP_ACTIONS) as HelpActionId[]).filter((id) => {
    const needs: Needs = HELP_ACTIONS[id].needs;
    if (needs === 'trail' && !screen.hasTrail) return false;
    if (needs === 'noTrail' && screen.hasTrail) return false;
    // An open drive has no guide points and no tour of its own, and the list
    // is on the trails side.
    if (screen.driveTrail && (id === 'openGuidePoints' || id === 'showTour')) return false;
    if (screen.mode === 'drive' && !screen.hasTrail && (id === 'openDiscovery' || id === 'openWorldTrails')) return false;
    if (id === 'record' && screen.recording) return false;
    return true;
  });
}
