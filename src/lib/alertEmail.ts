import { adminEmails } from './supabaseServer';

// Email to the admin, through Resend (resend.com — 3,000 a month free).
//
// RESEND_API_KEY   the key, from resend.com → API Keys
// ALERT_EMAIL      where alerts go; defaults to the first of ADMIN_EMAILS
// ALERT_FROM       the sender; defaults to Resend's own test address, which
//                  may send only to the address the Resend account was opened
//                  with — so open it with the alert address, or verify a
//                  domain in Resend and set ALERT_FROM to an address on it.
//
// Without a key nothing is sent; the alerts are still listed in the admin's
// screen (ai_alerts).

export function alertRecipient(): string | null {
  return process.env.ALERT_EMAIL?.trim() || adminEmails()[0] || null;
}

export function isAlertEmailConfigured(): boolean {
  return !!process.env.RESEND_API_KEY && !!alertRecipient();
}

export async function sendAlertEmail(subject: string, body: string): Promise<{ ok: boolean; detail: string }> {
  const key = process.env.RESEND_API_KEY;
  const to = alertRecipient();
  if (!key || !to) return { ok: false, detail: 'RESEND_API_KEY or the recipient is not set' };
  try {
    const res = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        from: process.env.ALERT_FROM?.trim() || 'Navi <onboarding@resend.dev>',
        to: [to],
        subject,
        // Right-to-left, so the Hebrew reads properly in any mail client.
        html: `<div dir="rtl" style="font-family:Arial,sans-serif;font-size:15px;line-height:1.6">${escapeHtml(body)}
          <p style="color:#555;font-size:13px">ההגדרות והפירוט: Navi ← הגדרות ← שימוש ועלויות AI.</p></div>`,
        text: body,
      }),
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) {
      const detail = (await res.text()).slice(0, 300);
      console.error('Alert email failed:', res.status, detail);
      return { ok: false, detail: `${res.status}: ${detail}` };
    }
    return { ok: true, detail: 'sent' };
  } catch (e) {
    const detail = e instanceof Error ? e.message : String(e);
    console.error('Alert email failed:', detail);
    return { ok: false, detail };
  }
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
}
