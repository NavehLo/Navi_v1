package app.navi.trails;

import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.content.Context;
import android.content.Intent;
import android.media.AudioAttributes;
import android.media.MediaPlayer;
import android.os.Build;
import android.os.Handler;
import android.os.Looper;
import android.os.VibrationEffect;
import android.os.Vibrator;

import androidx.core.app.NotificationCompat;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

/**
 * The off-route alarm, played natively.
 *
 * The sound goes out on the ALARM stream: it follows the phone's alarm volume
 * (not the ringer), and it plays in silent mode and through Do Not Disturb —
 * which a notification sound does not. The volume chosen in the app's settings
 * scales it on top of that. Alongside it, a silent high-priority notification
 * with vibration, so the alarm can be seen on the lock screen; tapping it opens
 * the app and silences the sound.
 *
 * Looping and the time limit are done here, not in the page: in the background
 * the page's timers are throttled, but a Handler on the main thread is not.
 */
@CapacitorPlugin(name = "AlarmSound")
public class AlarmSoundPlugin extends Plugin {
    static final String ACTION_SILENCE = "app.navi.trails.SILENCE_ALARM";
    private static final String CHANNEL_ID = "offroute-alert-silent";
    private static final int NOTIFICATION_ID = 7002;

    private static AlarmSoundPlugin instance;
    private MediaPlayer player;
    private final Handler handler = new Handler(Looper.getMainLooper());

    @Override
    public void load() {
        instance = this;
    }

    /** Called by MainActivity when the notification is tapped. */
    static void silenceFromNotification() {
        if (instance == null) return;
        instance.stopAll();
        instance.notifyListeners("silenced", new JSObject());
    }

    @PluginMethod
    public void play(PluginCall call) {
        String sound = call.getString("sound", "siren");
        float volume = call.getFloat("volume", 1f);
        boolean loop = call.getBoolean("loop", false);
        int maxMs = call.getInt("maxMs", 30000);
        String title = call.getString("title", null);
        String body = call.getString("body", "");

        handler.post(() -> {
            stopSound();
            Context ctx = getContext();
            int res = ctx.getResources().getIdentifier("alarm_" + sound.replace('-', '_'), "raw", ctx.getPackageName());
            if (res == 0) res = ctx.getResources().getIdentifier("alarm_siren", "raw", ctx.getPackageName());
            try {
                MediaPlayer mp = new MediaPlayer();
                mp.setAudioAttributes(new AudioAttributes.Builder()
                        .setUsage(AudioAttributes.USAGE_ALARM)
                        .setContentType(AudioAttributes.CONTENT_TYPE_SONIFICATION)
                        .build());
                android.content.res.AssetFileDescriptor afd = ctx.getResources().openRawResourceFd(res);
                mp.setDataSource(afd.getFileDescriptor(), afd.getStartOffset(), afd.getLength());
                afd.close();
                mp.setLooping(loop);
                float v = Math.max(0f, Math.min(1f, volume));
                mp.setVolume(v, v);
                mp.prepare();
                mp.start();
                player = mp;
                if (loop) handler.postDelayed(this::stopAll, maxMs);
            } catch (Exception e) {
                call.reject("Could not play the alarm", e);
                return;
            }
            if (title != null) {
                showNotification(title, body);
                vibrate();
            }
            call.resolve();
        });
    }

    @PluginMethod
    public void stop(PluginCall call) {
        handler.post(() -> {
            stopAll();
            call.resolve();
        });
    }

    private void stopAll() {
        stopSound();
        NotificationManager nm = (NotificationManager) getContext().getSystemService(Context.NOTIFICATION_SERVICE);
        if (nm != null) nm.cancel(NOTIFICATION_ID);
        Vibrator vib = (Vibrator) getContext().getSystemService(Context.VIBRATOR_SERVICE);
        if (vib != null) vib.cancel();
    }

    private void stopSound() {
        handler.removeCallbacksAndMessages(null);
        if (player != null) {
            try { player.stop(); } catch (Exception ignored) {}
            player.release();
            player = null;
        }
    }

    private void vibrate() {
        Vibrator vib = (Vibrator) getContext().getSystemService(Context.VIBRATOR_SERVICE);
        if (vib == null) return;
        long[] pattern = {0, 400, 150, 400, 150, 800};
        if (Build.VERSION.SDK_INT >= 26) vib.vibrate(VibrationEffect.createWaveform(pattern, -1));
        else vib.vibrate(pattern, -1);
    }

    private void showNotification(String title, String body) {
        Context ctx = getContext();
        NotificationManager nm = (NotificationManager) ctx.getSystemService(Context.NOTIFICATION_SERVICE);
        if (nm == null) return;
        if (Build.VERSION.SDK_INT >= 26 && nm.getNotificationChannel(CHANNEL_ID) == null) {
            NotificationChannel ch = new NotificationChannel(CHANNEL_ID, "התראת סטייה מהמסלול", NotificationManager.IMPORTANCE_HIGH);
            ch.setDescription("מוצגת כשמתרחקים מהמסלול. הצליל עצמו מושמע בנפרד, בעוצמה שנבחרה בהגדרות.");
            ch.setSound(null, null); // the sound is the MediaPlayer above
            ch.enableVibration(false); // and the vibration too
            nm.createNotificationChannel(ch);
        }
        Intent open = new Intent(ctx, MainActivity.class).setAction(ACTION_SILENCE)
                .addFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP | Intent.FLAG_ACTIVITY_CLEAR_TOP);
        PendingIntent pi = PendingIntent.getActivity(ctx, 0, open, PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);
        NotificationCompat.Builder b = new NotificationCompat.Builder(ctx, CHANNEL_ID)
                .setSmallIcon(android.R.drawable.ic_dialog_alert)
                .setContentTitle(title)
                .setContentText(body)
                .setPriority(NotificationCompat.PRIORITY_HIGH)
                .setCategory(NotificationCompat.CATEGORY_ALARM)
                .setContentIntent(pi)
                .setAutoCancel(true)
                .addAction(0, "השתק", pi);
        nm.notify(NOTIFICATION_ID, b.build());
    }
}
