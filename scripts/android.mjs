#!/usr/bin/env node
/**
 * Run the Android build's Gradle wrapper from the repository root.
 *
 *     npm run test:android                  JVM unit tests
 *     npm run test:android:device           instrumented tests on a running emulator or phone
 *     npm run build:android                 debug APK
 *     node scripts/android.mjs <tasks...>   anything else
 *
 * Gradle needs JAVA_HOME to point at JDK 21–25. The app has no Java sources, so a JDK without jlink
 * (such as an IDE's bundled runtime) is enough.
 */
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const directory = fileURLToPath(new URL('../apps/android/', import.meta.url));
const windows = process.platform === 'win32';
const tasks = process.argv.slice(2);

// By absolute path: a shell with NoDefaultCurrentDirectoryInExePath set does not look in the working directory.
const wrapper = fileURLToPath(new URL(windows ? 'gradlew.bat' : 'gradlew', new URL('../apps/android/', import.meta.url)));

const result = spawnSync(windows ? `"${wrapper}"` : wrapper, tasks.length > 0 ? tasks : [':app:testDebugUnitTest'], {
  cwd: directory,
  stdio: 'inherit',
  shell: windows,
});

if (result.error) {
  console.error(`Could not run Gradle: ${result.error.message}`);
  process.exit(1);
}

process.exit(result.status ?? 1);
