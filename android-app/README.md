# Navi for Android

A Capacitor shell that opens https://navi-v1.vercel.app. The site itself is
unchanged; inside the app it detects `Capacitor.isNativePlatform()` (see
`src/lib/native.ts`) and uses:

- `@capacitor-community/background-geolocation` — GPS that keeps coming with
  the screen off (foreground service + persistent notification).
- `@capacitor/local-notifications` — the off-route alarm as a max-importance
  notification whose sound is `android/app/src/main/res/raw/siren.wav`.
- `@capacitor/share` + `@capacitor/filesystem` — the share sheet, for a
  recorded walk's link and its GPX file (written to the app's cache first);
  the web view has no `navigator.share`.
- `@capacitor/browser` + `@capacitor/app` — Google sign-in in Chrome, returned
  via `app.navi.trails://auth-callback` (must be in Supabase → Auth → Redirect URLs).

Most changes are web changes: deploy the site and the app picks them up.
Rebuild the APK only when the native side changes (plugins, manifest, icon):

```bash
cd android-app && npm install && npx cap sync android
export JAVA_HOME="/Applications/Android Studio.app/Contents/jbr/Contents/Home"
cd android && ./gradlew assembleRelease
# → android/app/build/outputs/apk/release/app-release.apk
```

Gradle is 9.1 because Android Studio's bundled Java (25) is too new for 8.x;
the plugins' Java 21 toolchain is fetched by the foojay resolver in settings.gradle.
The APK is a release build (not debuggable, its web view closed to USB
inspection) signed with this Mac's debug key — keep building on this Mac, or
Android will refuse the update over the installed copy. Never ship
`assembleDebug`: a debug build lets anyone with the phone on a cable read the
app's storage, sign-in token and recordings included. Raise `versionCode` in
`android/app/build.gradle` with every APK.
