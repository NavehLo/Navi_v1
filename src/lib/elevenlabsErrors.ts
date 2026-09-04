// Turning an ElevenLabs failure into something a person can act on.
//
// The API answers with a JSON blob whose actionable part is buried in the
// middle, and whose obvious reading is often wrong — a 402 about a voice reads
// like "buy more credits" when credits are not the issue at all. The raw text
// still gets shown, because it is the ground truth and it carries a request_id
// worth quoting to support; this adds the sentence that says what to do.

export type ElevenLabsReason =
  | 'missing_permission'
  | 'library_voice_needs_paid_plan'
  | 'unauthorized'
  | 'voice_not_found'
  | 'rate_limited'
  | 'quota_exceeded'
  | null;

export interface ClassifiedError {
  reason: ElevenLabsReason;
  // Hebrew, addressed to whoever runs this app, naming the screen to open.
  hint: string | null;
  // The permission the key turned out to be missing, when the API named one.
  permission?: string;
}

// ElevenLabs keys are scoped: a key can be allowed to synthesize speech and
// still be forbidden from listing voices, which is exactly the combination
// that makes the voice picker come back empty while narration works.
const PERMISSION_RE = /missing the permission ([a-z_]+)/i;

export function classifyElevenLabsError(status: number | null, detail: string): ClassifiedError {
  const text = detail || '';

  const permissionMatch = PERMISSION_RE.exec(text);
  if (permissionMatch || /missing_permissions/.test(text)) {
    const permission = permissionMatch?.[1];
    return {
      reason: 'missing_permission',
      permission,
      hint:
        `למפתח ה-API חסרה ההרשאה ${permission ?? 'הנדרשת'}. ` +
        'ב-ElevenLabs: Profile → API Keys → ערוך את המפתח → סמן את ההרשאה החסרה → שמור. ' +
        'אין צורך במפתח חדש ואין צורך ב-Redeploy — ההרשאה חלה מיד.',
    };
  }

  if (/paid_plan_required|payment_required/.test(text) || status === 402) {
    return {
      reason: 'library_voice_needs_paid_plan',
      hint:
        'הקול הזה מגיע מה-Voice Library, וקולות משם חסומים ל-API בתוכנית החינמית — ' +
        'גם כשנשארו קרדיטים, וגם כשהוא מתנגן יפה באתר. זו מגבלה על סוג הקול ולא על הכמות. ' +
        'בחר קול מובנה (premade) מהרשימה, או שדרג מנוי.',
    };
  }

  if (/voice_not_found|voice does not exist/i.test(text) || status === 404) {
    return {
      reason: 'voice_not_found',
      hint: 'מזהה הקול לא נמצא בחשבון הזה. בדוק אותו מול ElevenLabs → Voices.',
    };
  }

  if (/quota|credits/i.test(text)) {
    return {
      reason: 'quota_exceeded',
      hint: 'נגמרו הקרדיטים בחשבון ElevenLabs. הם מתאפסים בתאריך החידוש, או שאפשר להוסיף top-up.',
    };
  }

  if (status === 429) {
    return {
      reason: 'rate_limited',
      hint: 'יותר מדי בקשות ל-ElevenLabs בבת אחת. המתן רגע ונסה שוב.',
    };
  }

  if (status === 401) {
    return {
      reason: 'unauthorized',
      hint: 'מפתח ה-API נדחה. ודא ש-ELEVENLABS_API_KEY ב-Vercel תקין ולא בוטל, ובצע Redeploy אחרי שינוי.',
    };
  }

  return { reason: null, hint: null };
}
