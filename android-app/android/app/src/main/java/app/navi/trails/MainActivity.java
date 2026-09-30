package app.navi.trails;

import android.content.Intent;
import android.os.Bundle;

import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {
    @Override
    public void onCreate(Bundle savedInstanceState) {
        // The app's own plugin (the alarm sound) — registered before the bridge starts.
        registerPlugin(AlarmSoundPlugin.class);
        super.onCreate(savedInstanceState);
        handleSilence(getIntent());
    }

    @Override
    protected void onNewIntent(Intent intent) {
        super.onNewIntent(intent);
        handleSilence(intent);
    }

    // Tapping the alarm notification (or its "השתק" button) opens the app and
    // stops the sound.
    private void handleSilence(Intent intent) {
        if (intent != null && AlarmSoundPlugin.ACTION_SILENCE.equals(intent.getAction())) {
            AlarmSoundPlugin.silenceFromNotification();
        }
    }
}
