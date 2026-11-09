package com.personalpacs.mobile;

import android.graphics.Color;
import android.os.Bundle;
import androidx.activity.EdgeToEdge;
import androidx.activity.SystemBarStyle;
import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {

    @Override
    public void onCreate(Bundle savedInstanceState) {
        // The app's own plugins: finding the PC on the local network, and dictation.
        registerPlugin(LanPlugin.class);
        registerPlugin(DictationPlugin.class);
        super.onCreate(savedInstanceState);
        // Only after Capacitor has switched from the launch (splash) theme: doing this earlier builds
        // the window with the launch theme, which showed a title bar painted with the splash image.
        // Light status/navigation bar icons on the app's black background.
        EdgeToEdge.enable(this, SystemBarStyle.dark(Color.TRANSPARENT), SystemBarStyle.dark(Color.TRANSPARENT));
    }
}
