// What the users report ("משתמשים ושימוש") counts of the app itself: one
// name per action, and its Hebrew label for the admin's screen. The server
// (api/events) keeps only names listed here; a new user-facing feature adds
// its name and label here and calls `track` (lib/track) where it is used.

export const EVENT_LABELS = {
  app_open: 'פתיחת האפליקציה',
  sign_in: 'כניסה לאפליקציה כמשתמש מחובר',
  trail_open_israel: 'פתיחת מסלול בישראל',
  trail_open_world: 'פתיחת מסלול בעולם',
  trail_open_file: 'טעינת קובץ מסלול (GPX/KML)',
  drive_open: 'פתיחת טיול בכביש',
  world_card: 'כרטיס מסלול בעולם (מהמפה או מהרשימה)',
  trail_discovery: 'רשימת מסלולי ישראל',
  world_by_month: 'מסלולים בעולם — לפי חודש ומדינה',
  world_ranking: 'מסלולים בעולם — לפי דירוג',
  hiker_heat: 'מפת חום של מטיילים',
  country_guide: 'אזורי טיול של מדינה',
  place_search: 'חיפוש מקום',
  virtual_tour: 'סיור וירטואלי',
  guide_on: 'הפעלת המדריך הקולי',
  trail_info: 'על המסלול',
  photos_open: 'תמונות מהמסלול',
  live_location: 'מיקום חי בשטח',
  measure: 'מדידת מרחק / תכנון',
  offline_download: 'הורדת מסלול לשטח',
  record_start: 'התחלת הקלטת הליכה',
  record_save: 'שמירת הקלטה',
  save_trail: 'שמירת מסלול באזור האישי',
  personal_area: 'האזור האישי',
  help_chat: 'שאלו את Navi',
  help_tour: 'סיור הדרכה באפליקציה',
} as const;

export type AppEvent = keyof typeof EVENT_LABELS;

export const isAppEvent = (name: unknown): name is AppEvent =>
  typeof name === 'string' && Object.prototype.hasOwnProperty.call(EVENT_LABELS, name);
