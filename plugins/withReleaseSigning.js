const { withAppBuildGradle } = require('expo/config-plugins');

/**
 * Teaches the generated Android project to sign release builds with a real key.
 *
 * `android/` is generated and gitignored, so editing its build.gradle by hand
 * lasts exactly until the next `expo prebuild`. A config plugin runs *as part
 * of* prebuild, so the signing config is reapplied every time the project is
 * regenerated — including on a clean CI checkout.
 *
 * Credentials are never stored here. The injected Gradle reads four properties:
 *
 *   SPOOL_STORE_FILE       absolute path to the .jks
 *   SPOOL_STORE_PASSWORD
 *   SPOOL_KEY_ALIAS
 *   SPOOL_KEY_PASSWORD
 *
 * Supply them with `-P` flags, in `~/.gradle/gradle.properties`, or via
 * `ORG_GRADLE_PROJECT_*` environment variables. When SPOOL_STORE_FILE is
 * absent the release build falls back to debug signing, so a contributor who
 * has never seen a keystore can still run `expo run:android --variant release`.
 */

const MARKER = '// spool:release-signing';

const SIGNING_CONFIG = `
        ${MARKER}
        release {
            if (project.hasProperty('SPOOL_STORE_FILE')) {
                storeFile file(project.property('SPOOL_STORE_FILE'))
                storePassword project.property('SPOOL_STORE_PASSWORD')
                keyAlias project.property('SPOOL_KEY_ALIAS')
                keyPassword project.property('SPOOL_KEY_PASSWORD')
            }
        }
`;

module.exports = function withReleaseSigning(config) {
  return withAppBuildGradle(config, (cfg) => {
    if (cfg.modResults.language !== 'groovy') {
      throw new Error('withReleaseSigning expects a Groovy build.gradle');
    }

    let gradle = cfg.modResults.contents;

    // Idempotent: prebuild can run repeatedly against an existing project.
    if (gradle.includes(MARKER)) return cfg;

    // Add a `release` entry alongside the template's `debug` signing config.
    const signingConfigs = gradle.match(/(\n\s*signingConfigs\s*\{)/);
    if (!signingConfigs) {
      throw new Error('withReleaseSigning: no signingConfigs block in build.gradle');
    }
    gradle = gradle.replace(signingConfigs[1], `${signingConfigs[1]}\n${SIGNING_CONFIG}`);

    // Point the release build type at it, but only when a keystore was
    // supplied — otherwise Gradle fails on a signingConfig with no storeFile.
    const releaseSigning = /(buildTypes\s*\{[\s\S]*?release\s*\{[\s\S]*?)signingConfig signingConfigs\.debug/;
    if (!releaseSigning.test(gradle)) {
      throw new Error('withReleaseSigning: release build type not shaped as expected');
    }
    gradle = gradle.replace(
      releaseSigning,
      "$1signingConfig project.hasProperty('SPOOL_STORE_FILE') ? signingConfigs.release : signingConfigs.debug",
    );

    cfg.modResults.contents = gradle;
    return cfg;
  });
};
