import { isNativeApp, nativeFileShareAvailable, nativeShareAvailable, shareNative } from '../native';
import { gpxFileName, recordingToGpx } from './gpx';
import type { Recording } from './types';

// Handing a recording to someone else: a link that opens it in Navi, or the
// GPX file for any other app. In the Android app through its share sheet; in
// a browser through the Web Share API where there is one, otherwise the link
// is copied and the file downloaded.

export function walkLink(id: string): string {
  return `${window.location.origin}/?walk=${id}`;
}

function isCancel(e: unknown) {
  return (e as Error)?.name === 'AbortError' || /cancel/i.test(String((e as Error)?.message ?? e));
}

export async function shareWalkLink(rec: Recording): Promise<'shared' | 'copied'> {
  const url = walkLink(rec.id);
  const title = `מסלול: ${rec.name}`;
  const text = `ההליכה שלי ב-Navi — ${rec.name}`;
  if (nativeShareAvailable()) {
    await shareNative({ title, text, url });
    return 'shared';
  }
  if (!isNativeApp() && navigator.share) {
    try { await navigator.share({ title, text, url }); } catch (e) { if (!isCancel(e)) throw e; }
    return 'shared';
  }
  await navigator.clipboard.writeText(url);
  return 'copied';
}

export async function shareGpxFile(rec: Recording): Promise<'shared' | 'downloaded' | 'unsupported'> {
  const content = recordingToGpx(rec);
  const name = gpxFileName(rec.name);
  if (nativeFileShareAvailable()) {
    await shareNative({ title: rec.name, file: { name, content } });
    return 'shared';
  }
  // An app installed before sharing was added: its web view can neither
  // share nor download a file.
  if (isNativeApp()) return 'unsupported';
  const file = new File([content], name, { type: 'application/gpx+xml' });
  if (navigator.canShare?.({ files: [file] })) {
    try { await navigator.share({ files: [file], title: rec.name }); } catch (e) { if (!isCancel(e)) throw e; }
    return 'shared';
  }
  const url = URL.createObjectURL(file);
  const a = Object.assign(document.createElement('a'), { href: url, download: name });
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
  return 'downloaded';
}
