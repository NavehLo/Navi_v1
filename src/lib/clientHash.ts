import { createHash } from 'node:crypto';

// A guest is told apart by IP, stored only as a salted hash.
export function hashClient(ip: string): string {
  return createHash('sha256').update(`navi-client:${ip}:${process.env.SUPABASE_SERVICE_ROLE_KEY ?? ''}`).digest('hex').slice(0, 32);
}

// The id the page sent (lib/authHeaders), when it looks like one.
export function deviceOf(request: Request): string | null {
  const id = request.headers.get('x-navi-device');
  return id && /^[a-z0-9-]{8,64}$/i.test(id) ? id : null;
}

export function isNativeRequest(request: Request): boolean {
  return request.headers.get('x-navi-native') === '1';
}

// A few words that tell the admin's devices apart in the list: the phone's
// model where the browser gives it (the app's web view does), else the system.
export function describeDevice(request: Request): string {
  const ua = request.headers.get('user-agent') ?? '';
  const where = isNativeRequest(request) ? 'האפליקציה' : 'דפדפן';
  const model = /Android [\d.]+; ([^;)]+?)(?: Build\/[^;)]*)?[;)]/.exec(ua)?.[1];
  const system = model && model !== 'K' ? model
    : /Android/.test(ua) ? 'Android'
    : /iPhone|iPad/.test(ua) ? 'iOS'
    : /Mac OS X/.test(ua) ? 'Mac'
    : /Windows/.test(ua) ? 'Windows'
    : 'מכשיר';
  return `${system} · ${where}`;
}
