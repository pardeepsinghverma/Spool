const fs = require('fs');
const path = require('path');

/**
 * Ensures react-native-webview rotates to landscape on Android when fullscreen
 * video is entered, and restores portrait when fullscreen video is exited.
 *
 * In standard react-native-webview, onShowCustomView sets
 * `activity.requestedOrientation = ActivityInfo.SCREEN_ORIENTATION_UNSPECIFIED`.
 * In an app with `android:screenOrientation="portrait"` in AndroidManifest.xml
 * (or when the user has auto-rotate locked), SCREEN_ORIENTATION_UNSPECIFIED
 * falls back to portrait and never rotates to landscape.
 *
 * This patch changes:
 * 1. initialRequestedOrientation fallback to portrait if unspecified.
 * 2. onShowCustomView sets SCREEN_ORIENTATION_SENSOR_LANDSCAPE so the video
 *    rotates to landscape regardless of orientation lock and supports both
 *    left and right tilt.
 * 3. onHideCustomView restores initialRequestedOrientation (portrait).
 * 4. Adds back key listener to custom view so hardware/gesture back cleanly
 *    exits fullscreen rather than triggering page back or app exit.
 */

function patchRNCWebView() {
  const targetPath = path.resolve(
    __dirname,
    '../node_modules/react-native-webview/android/src/main/java/com/reactnativecommunity/webview/RNCWebViewManagerImpl.kt'
  );

  if (!fs.existsSync(targetPath)) {
    return;
  }

  let code = fs.readFileSync(targetPath, 'utf8');

  // Idempotent check
  if (code.includes('SCREEN_ORIENTATION_SENSOR_LANDSCAPE')) {
    return;
  }

  // Add KeyEvent import if missing
  if (!code.includes('import android.view.KeyEvent')) {
    code = code.replace(
      'import android.view.View',
      'import android.view.KeyEvent\nimport android.view.View'
    );
  }

  // Update initialRequestedOrientation to fallback safely to PORTRAIT
  code = code.replace(
    'val initialRequestedOrientation = activity.requestedOrientation',
    'val initialRequestedOrientation = if (activity.requestedOrientation != ActivityInfo.SCREEN_ORIENTATION_UNSPECIFIED) activity.requestedOrientation else ActivityInfo.SCREEN_ORIENTATION_PORTRAIT'
  );

  // Update onShowCustomView to rotate to SENSOR_LANDSCAPE and hook back key
  const targetSnippet = 'activity.requestedOrientation = ActivityInfo.SCREEN_ORIENTATION_UNSPECIFIED';
  const replacementSnippet = `activity.requestedOrientation = ActivityInfo.SCREEN_ORIENTATION_SENSOR_LANDSCAPE
                        mVideoView.isFocusable = true
                        mVideoView.isFocusableInTouchMode = true
                        mVideoView.requestFocus()
                        mVideoView.setOnKeyListener { _, keyCode, event ->
                            if (keyCode == KeyEvent.KEYCODE_BACK && event.action == KeyEvent.ACTION_UP) {
                                onHideCustomView()
                                true
                            } else {
                                false
                            }
                        }`;

  code = code.replace(targetSnippet, replacementSnippet);

  fs.writeFileSync(targetPath, code, 'utf8');
}

// Run patch immediately when required or executed
patchRNCWebView();

module.exports = function withFullscreenOrientation(config) {
  patchRNCWebView();
  return config;
};
