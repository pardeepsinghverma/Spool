const { withAndroidManifest } = require('expo/config-plugins');

/**
 * Opts Spool into Android 16's 16 KB page-size compatibility mode.
 *
 * Android 16 devices use 16 KB memory pages and refuse to launch native apps
 * cleanly unless their libraries can be mapped directly from the APK — which
 * requires them stored uncompressed and 16 KB zip-aligned. Without this, the
 * system shows "This app isn't compatible with the latest version of Android"
 * on every launch.
 *
 * Every library we ship is *internally* 16 KB aligned already, including
 * youtubedl-android's (added in 0.18.0). The incompatibility comes from
 * packaging: we set `useLegacyPackaging` so native libs are compressed and
 * extracted to disk at install, because youtubedl-android reads
 * `libpython.zip.so` off the filesystem to unpack its Python runtime. An
 * uncompressed APK entry is not a real file, so turning legacy packaging off
 * makes the engine fail to initialise.
 *
 * So the two requirements are in direct conflict, and this is the supported way
 * out: compat mode keeps 4 KB semantics for this app. It costs a little memory
 * performance and Google Play would reject it for apps targeting Android 15+,
 * which does not bind us — Spool is sideloaded by design.
 *
 * The cleaner fix, if youtubedl-android ever reads its payload out of the APK
 * via ApplicationInfo.sourceDir instead of nativeLibraryDir, is to drop legacy
 * packaging and remove this plugin.
 */
module.exports = function withPageSizeCompat(config) {
  return withAndroidManifest(config, (cfg) => {
    const application = cfg.modResults?.manifest?.application?.[0];
    if (!application) {
      throw new Error('withPageSizeCompat: no <application> in AndroidManifest');
    }
    application.$['android:pageSizeCompat'] = 'enabled';
    return cfg;
  });
};
