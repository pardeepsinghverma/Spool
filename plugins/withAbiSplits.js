const { withAppBuildGradle } = require('expo/config-plugins');

/**
 * Splits the release build into one APK per CPU architecture.
 *
 * yt-dlp arrives as a Python runtime plus an ffmpeg build, shipped per ABI.
 * A universal APK therefore carries four copies of both — ~33 MB of ffmpeg and
 * ~13 MB of Python each — which is 253 MB of native libraries out of a 226 MB
 * download. Per-ABI APKs cut that to roughly a third.
 *
 * Note that `abiFilters` in the ytdlp module does NOT prevent this: it
 * constrains that module's own native compilation, not the jniLibs the
 * youtubedl-android AAR brings transitively. Splitting at the app level is what
 * actually works.
 *
 * x86 is deliberately excluded — it is emulator-only and the ytdlp module does
 * not claim to support it. x86_64 is kept so the emulator still works.
 */

const MARKER = '// spool:abi-splits';

const SPLITS = `
    ${MARKER}
    splits {
        abi {
            enable true
            reset()
            include 'arm64-v8a', 'armeabi-v7a', 'x86_64'
            universalApk false
        }
    }
`;

module.exports = function withAbiSplits(config) {
  return withAppBuildGradle(config, (cfg) => {
    if (cfg.modResults.language !== 'groovy') {
      throw new Error('withAbiSplits expects a Groovy build.gradle');
    }

    let gradle = cfg.modResults.contents;
    if (gradle.includes(MARKER)) return cfg;

    // Anchor on the app module's `android {` block opener.
    const androidBlock = gradle.match(/(\nandroid\s*\{)/);
    if (!androidBlock) {
      throw new Error('withAbiSplits: no android block in build.gradle');
    }

    gradle = gradle.replace(androidBlock[1], `${androidBlock[1]}\n${SPLITS}`);
    cfg.modResults.contents = gradle;
    return cfg;
  });
};
