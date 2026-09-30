"""The off-route alarm sounds, from the calmest to the harshest.

Synthesised here rather than downloaded, so there is no licence to track and
the web and the Android app play exactly the same files:
  public/sounds/alarm-<id>.wav                    (the site)
  android-app/android/app/src/main/res/raw/alarm_<id>.wav   (the app)
Each file is one round of the sound followed by a short silence, so playing
it on a loop gives the rhythm. Peaks are normalised; the loudness heard is
set by the volume in the settings.

Run: python3 scripts/generateAlarmSounds.py   (then rebuild the APK)
Keep the ids in step with ALARM_SOUNDS in src/lib/offRouteAlert.ts.
"""
import math, os, struct, wave

RATE = 22050
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
WEB = os.path.join(ROOT, 'public', 'sounds')
RAW = os.path.join(ROOT, 'android-app', 'android', 'app', 'src', 'main', 'res', 'raw')

def silence(sec): return [0.0] * int(RATE * sec)

def tone(freq, sec, wave_='sine', decay=None, attack=0.005, sweep_to=None):
    out, phase = [], 0.0
    n = int(RATE * sec)
    for i in range(n):
        t = i / RATE
        f = freq if sweep_to is None else freq + (sweep_to - freq) * (i / n)
        phase += 2 * math.pi * f / RATE
        if wave_ == 'sine': v = math.sin(phase)
        elif wave_ == 'triangle': v = 2 / math.pi * math.asin(math.sin(phase))
        elif wave_ == 'square': v = 1.0 if math.sin(phase) >= 0 else -1.0
        elif wave_ == 'saw': v = 2 * ((phase / (2 * math.pi)) % 1) - 1
        env = min(1.0, t / attack) if attack else 1.0
        if decay: env *= math.exp(-t / decay)
        else: env *= min(1.0, (sec - t) / 0.01)  # click-free end
        out.append(v * env)
    return out

def mix(*parts):
    n = max(len(p) for p in parts)
    return [sum(p[i] for p in parts if i < len(p)) for i in range(n)]

def bell(freq, sec, decay):
    # A struck bell: the fundamental and two quieter partials.
    return mix(tone(freq, sec, decay=decay), [x * 0.4 for x in tone(freq * 2.76, sec, decay=decay / 2)],
               [x * 0.2 for x in tone(freq * 5.4, sec, decay=decay / 4)])

SOUNDS = {
    # 1 — one soft bell, twice
    'soft-bell': lambda: bell(523, 1.3, 0.5) + bell(523, 1.3, 0.5) + silence(0.6),
    # 2 — three rising chime notes
    'chime': lambda: bell(1047, 0.35, 0.25) + bell(1319, 0.35, 0.25) + bell(1568, 0.9, 0.35) + silence(0.8),
    # 3 — a marimba figure
    'marimba': lambda: sum((tone(f, 0.22, 'triangle', decay=0.09) for f in (784, 988, 784, 1175)), []) + silence(0.9),
    # 4 — bird-like chirps
    'bird': lambda: sum((tone(2600, 0.09, sweep_to=4200, attack=0.003) + silence(0.07) for _ in range(3)), []) + silence(0.2)
                    + sum((tone(2600, 0.09, sweep_to=4200, attack=0.003) + silence(0.07) for _ in range(3)), []) + silence(0.9),
    # 5 — three plain beeps
    'beep': lambda: sum((tone(1000, 0.16) + silence(0.14) for _ in range(3)), []) + silence(0.9),
    # 6 — an alarm clock: fast beep-beep-beep-beep, twice
    'clock': lambda: (sum((tone(2000, 0.07, 'square') + silence(0.06) for _ in range(4)), []) + silence(0.35)) * 2 + silence(0.5),
    # 7 — a horn, pulsing
    'horn': lambda: sum((mix(tone(330, 0.45, 'saw'), tone(415, 0.45, 'saw')) + silence(0.15) for _ in range(3)), []) + silence(0.6),
    # 8 — the siren: two-tone square wave (the original alarm)
    'siren': lambda: sum((tone(880 if i % 2 == 0 else 1320, 0.32, 'square') + silence(0.08) for i in range(6)), []) + silence(0.6),
}

def write(path, samples):
    peak = max(abs(s) for s in samples) or 1
    with wave.open(path, 'wb') as w:
        w.setnchannels(1); w.setsampwidth(2); w.setframerate(RATE)
        w.writeframes(b''.join(struct.pack('<h', int(s / peak * 0.9 * 32767)) for s in samples))

os.makedirs(WEB, exist_ok=True); os.makedirs(RAW, exist_ok=True)
for sid, make in SOUNDS.items():
    s = make()
    write(os.path.join(WEB, f'alarm-{sid}.wav'), s)
    write(os.path.join(RAW, f'alarm_{sid.replace("-", "_")}.wav'), s)
    print(f'{sid:10s} {len(s) / RATE:.1f}s')
