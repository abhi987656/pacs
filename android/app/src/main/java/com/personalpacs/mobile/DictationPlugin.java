package com.personalpacs.mobile;

import android.Manifest;
import android.content.Intent;
import android.os.Build;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.speech.RecognitionListener;
import android.speech.RecognizerIntent;
import android.speech.SpeechRecognizer;
import com.getcapacitor.JSObject;
import com.getcapacitor.PermissionState;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import com.getcapacitor.annotation.Permission;
import com.getcapacitor.annotation.PermissionCallback;
import java.util.ArrayList;

/**
 * Continuous dictation with Android's speech recognition (Google's engine on most phones; offline
 * when the offline language pack is installed). Android stops listening after every pause, so
 * this restarts it until the user taps the mic again. Events: partial, final, state, error.
 */
@CapacitorPlugin(name = "Dictation", permissions = { @Permission(strings = { Manifest.permission.RECORD_AUDIO }, alias = "microphone") })
public class DictationPlugin extends Plugin {

    private final Handler main = new Handler(Looper.getMainLooper());
    private SpeechRecognizer recognizer;
    private boolean active = false;
    private String language = "en-IN";
    private boolean preferOffline = true;
    private int errorsInARow = 0;

    @PluginMethod
    public void available(PluginCall call) {
        JSObject ret = new JSObject();
        ret.put("available", SpeechRecognizer.isRecognitionAvailable(getContext()));
        boolean onDevice = false;
        if (Build.VERSION.SDK_INT >= 31) {
            try {
                onDevice = SpeechRecognizer.isOnDeviceRecognitionAvailable(getContext());
            } catch (Exception ignored) {}
        }
        ret.put("onDevice", onDevice);
        call.resolve(ret);
    }

    @PluginMethod
    public void start(PluginCall call) {
        if (getPermissionState("microphone") != PermissionState.GRANTED) {
            requestPermissionForAlias("microphone", call, "micPermissionCallback");
            return;
        }
        begin(call);
    }

    @PermissionCallback
    private void micPermissionCallback(PluginCall call) {
        if (getPermissionState("microphone") == PermissionState.GRANTED) {
            begin(call);
        } else {
            call.reject("Microphone permission was refused. Allow it for Personal PACS in Android Settings › Apps › Permissions.");
        }
    }

    private void begin(final PluginCall call) {
        language = call.getString("language", "en-IN");
        Boolean offline = call.getBoolean("preferOffline", true);
        preferOffline = offline == null || offline;
        active = true;
        errorsInARow = 0;
        main.post(() -> {
            listen();
            call.resolve();
        });
    }

    @PluginMethod
    public void stop(final PluginCall call) {
        active = false;
        main.post(() -> {
            if (recognizer != null) {
                try {
                    recognizer.cancel();
                } catch (Exception ignored) {}
            }
            notifyState(false);
            call.resolve();
        });
    }

    private void listen() {
        if (!active) return;
        try {
            if (recognizer == null) {
                recognizer = SpeechRecognizer.createSpeechRecognizer(getContext());
                recognizer.setRecognitionListener(listener);
            }
            Intent intent = new Intent(RecognizerIntent.ACTION_RECOGNIZE_SPEECH);
            intent.putExtra(RecognizerIntent.EXTRA_LANGUAGE_MODEL, RecognizerIntent.LANGUAGE_MODEL_FREE_FORM);
            intent.putExtra(RecognizerIntent.EXTRA_LANGUAGE, language);
            intent.putExtra(RecognizerIntent.EXTRA_PARTIAL_RESULTS, true);
            intent.putExtra(RecognizerIntent.EXTRA_MAX_RESULTS, 1);
            intent.putExtra(RecognizerIntent.EXTRA_PREFER_OFFLINE, preferOffline);
            intent.putExtra(RecognizerIntent.EXTRA_CALLING_PACKAGE, getContext().getPackageName());
            // Ask for longer pauses before a phrase ends (not every engine honours this).
            intent.putExtra(RecognizerIntent.EXTRA_SPEECH_INPUT_COMPLETE_SILENCE_LENGTH_MILLIS, 2000L);
            intent.putExtra(RecognizerIntent.EXTRA_SPEECH_INPUT_POSSIBLY_COMPLETE_SILENCE_LENGTH_MILLIS, 1500L);
            recognizer.startListening(intent);
        } catch (Exception e) {
            fail(e.getMessage() == null ? "Speech recognition could not start." : e.getMessage());
        }
    }

    private void restart(long delayMs) {
        if (active) main.postDelayed(this::listen, delayMs);
    }

    private void recreate(long delayMs) {
        if (recognizer != null) {
            try {
                recognizer.destroy();
            } catch (Exception ignored) {}
            recognizer = null;
        }
        restart(delayMs);
    }

    private void fail(String message) {
        active = false;
        JSObject e = new JSObject();
        e.put("message", message);
        e.put("fatal", true);
        notifyListeners("error", e);
        notifyState(false);
    }

    private void notifyState(boolean listening) {
        JSObject s = new JSObject();
        s.put("listening", listening);
        notifyListeners("state", s);
    }

    private static String first(Bundle b) {
        if (b == null) return null;
        ArrayList<String> m = b.getStringArrayList(SpeechRecognizer.RESULTS_RECOGNITION);
        return (m == null || m.isEmpty()) ? null : m.get(0);
    }

    private final RecognitionListener listener = new RecognitionListener() {
        @Override
        public void onReadyForSpeech(Bundle params) {
            notifyState(true);
        }

        @Override
        public void onBeginningOfSpeech() {}

        @Override
        public void onRmsChanged(float rmsdB) {}

        @Override
        public void onBufferReceived(byte[] buffer) {}

        @Override
        public void onEndOfSpeech() {}

        @Override
        public void onPartialResults(Bundle partialResults) {
            String t = first(partialResults);
            if (t != null && !t.isEmpty()) {
                JSObject o = new JSObject();
                o.put("text", t);
                notifyListeners("partial", o);
            }
        }

        @Override
        public void onResults(Bundle results) {
            errorsInARow = 0;
            String t = first(results);
            if (t != null && !t.trim().isEmpty()) {
                JSObject o = new JSObject();
                o.put("text", t);
                notifyListeners("final", o);
            }
            restart(60);
        }

        @Override
        public void onError(int error) {
            if (!active) return;
            switch (error) {
                case SpeechRecognizer.ERROR_NO_MATCH:
                case SpeechRecognizer.ERROR_SPEECH_TIMEOUT:
                    // Just silence: keep listening.
                    restart(60);
                    break;
                case SpeechRecognizer.ERROR_INSUFFICIENT_PERMISSIONS:
                    fail("Microphone permission is missing for Personal PACS.");
                    break;
                case SpeechRecognizer.ERROR_NETWORK:
                case SpeechRecognizer.ERROR_NETWORK_TIMEOUT:
                case SpeechRecognizer.ERROR_SERVER:
                    fail("Speech recognition needs internet on this phone, or the offline English speech pack (Android Settings › search “offline speech”).");
                    break;
                case 12: // ERROR_LANGUAGE_NOT_SUPPORTED
                case 13: // ERROR_LANGUAGE_UNAVAILABLE
                    fail("This language/accent is not available for speech recognition. Choose another one in Settings or download the offline English pack.");
                    break;
                default:
                    // Busy / client / audio hiccups: start a fresh recognizer, give up after a few tries.
                    if (++errorsInARow > 5) {
                        fail("Speech recognition stopped (error " + error + "). Tap the mic to try again.");
                    } else {
                        recreate(300);
                    }
            }
        }

        @Override
        public void onEvent(int eventType, Bundle params) {}
    };

    @Override
    protected void handleOnPause() {
        super.handleOnPause();
        if (active) {
            active = false;
            main.post(() -> {
                if (recognizer != null) {
                    try {
                        recognizer.cancel();
                    } catch (Exception ignored) {}
                }
                notifyState(false);
            });
        }
    }

    @Override
    protected void handleOnDestroy() {
        active = false;
        if (recognizer != null) {
            try {
                recognizer.destroy();
            } catch (Exception ignored) {}
            recognizer = null;
        }
        super.handleOnDestroy();
    }
}
