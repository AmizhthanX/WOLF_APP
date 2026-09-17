import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  ALLOWED_PERMISSIONS,
  PACKAGE_NAME,
  parseBadging,
  parseSigner,
  releaseFindings,
  releaseSummary,
  removedNativeClasses,
} from './verify-android-release.mjs';

/** What a release gate refuses, from the tools' own output. */

const BADGING = [
  `package: name='${PACKAGE_NAME}' versionCode='2000' versionName='0.2.0' platformBuildVersionName='16' compileSdkVersion='36'`,
  "sdkVersion:'28'",
  "targetSdkVersion:'36'",
  "uses-permission: name='android.permission.INTERNET'",
  "uses-permission: name='android.permission.ACCESS_NETWORK_STATE'",
  "uses-permission: name='android.permission.POST_NOTIFICATIONS'",
  "uses-permission: name='android.permission.USE_BIOMETRIC'",
  "uses-permission: name='android.permission.FOREGROUND_SERVICE'",
  "uses-permission: name='android.permission.FOREGROUND_SERVICE_SPECIAL_USE'",
  "uses-permission: name='android.permission.WAKE_LOCK'",
  "uses-permission: name='com.google.android.c2dm.permission.RECEIVE'",
  `uses-permission: name='${PACKAGE_NAME}.DYNAMIC_RECEIVER_NOT_EXPORTED_PERMISSION'`,
  "application-label:'WOLF'",
].join('\r\n');

const SIGNED = [
  'Verifies',
  'Verified using v1 scheme (JAR signing): false',
  'Verified using v2 scheme (APK Signature Scheme v2): true',
  'Verified using v3 scheme (APK Signature Scheme v3): true',
  'Verified using v3.1 scheme (APK Signature Scheme v3.1): false',
  'Verified using v4 scheme (APK Signature Scheme v4): false',
  'Number of signers: 1',
  'Signer #1 certificate DN: CN=WOLF release, O=Amizhthan',
  'Signer #1 certificate SHA-256 digest: 0f1e2d3c4b5a69788796a5b4c3d2e1f00f1e2d3c4b5a69788796a5b4c3d2e1f0',
].join('\r\n');

function facts(overrides = {}) {
  return { badging: parseBadging(BADGING), signer: parseSigner(SIGNED), verified: true, ...overrides };
}

test('the tools output is read the same with Windows line endings', () => {
  const badging = parseBadging(BADGING);
  assert.equal(badging.packageName, PACKAGE_NAME);
  assert.equal(badging.versionName, '0.2.0');
  assert.equal(badging.versionCode, '2000');
  assert.equal(badging.debuggable, false);
  assert.equal(badging.permissions.length, 9);

  const signer = parseSigner(SIGNED);
  assert.deepEqual(signer.schemes, ['v2', 'v3']);
  assert.equal(signer.signers, 1);
  assert.match(signer.certificateSha256, /^[0-9a-f]{64}$/);
});

test('a signer named by SDK range is read as the one signer it is', () => {
  const ranged = parseSigner(
    [
      'Verifies',
      'Verified using v2 scheme (APK Signature Scheme v2): true',
      'Number of signers: 1',
      'Signer (minSdkVersion=28, maxSdkVersion=2147483647) certificate DN: CN=WOLF release, O=Amizhthan',
      'Signer (minSdkVersion=28, maxSdkVersion=2147483647) certificate SHA-256 digest: 0f1e2d3c4b5a69788796a5b4c3d2e1f00f1e2d3c4b5a69788796a5b4c3d2e1f0  ',
    ].join('\n'),
  );
  assert.equal(ranged.signers, 1);
  assert.equal(ranged.certificateDn, 'CN=WOLF release, O=Amizhthan');
  assert.match(ranged.certificateSha256, /^[0-9a-f]{64}$/);

  const twoKeys = parseSigner(`${SIGNED}\r\nSigner #2 certificate DN: CN=Someone else\r\nSigner #2 certificate SHA-256 digest: ${'ab'.repeat(32)}`);
  assert.equal(twoKeys.signers, 2);
});

test('a properly signed release with the permissions WOLF chose is releasable', () => {
  assert.deepEqual(releaseFindings({ ...facts(), expectedVersionName: '0.2.0', expectedVersionCode: '2000' }), []);
});

test('a permission a dependency slipped in fails the release', () => {
  const badging = parseBadging(`${BADGING}\r\nuses-permission: name='com.google.android.gms.permission.AD_ID'\r\nuses-permission-sdk-23: name='android.permission.RECORD_AUDIO'`);
  const findings = releaseFindings(facts({ badging }));

  assert.equal(findings.length, 2);
  assert.match(findings[0], /AD_ID/);
  assert.match(findings[1], /RECORD_AUDIO/);
});

test('a debuggable build, a debug certificate, or JAR signing alone are not releases', () => {
  assert.match(releaseFindings(facts({ badging: parseBadging(`${BADGING}\napplication-debuggable`) })).join(), /debuggable/);

  const debugSigned = parseSigner(SIGNED.replace('CN=WOLF release, O=Amizhthan', 'C=US, O=Android, CN=Android Debug'));
  assert.match(releaseFindings(facts({ signer: debugSigned })).join(), /debug certificate/);

  const jarOnly = parseSigner(SIGNED.replace('(JAR signing): false', '(JAR signing): true').replaceAll('v2): true', 'v2): false').replaceAll('v3): true', 'v3): false'));
  assert.match(releaseFindings(facts({ signer: jarOnly })).join(), /v2 or later/);

  assert.match(releaseFindings(facts({ verified: false })).join(), /does not verify/);
});

test('the version the pipeline meant to build is the version in the APK', () => {
  const findings = releaseFindings({ ...facts(), expectedVersionName: '0.3.0', expectedVersionCode: '3000' });
  assert.equal(findings.length, 2);
});

test('the release notes carry the fingerprints and a reason for every permission', () => {
  const summary = releaseSummary({ badging: parseBadging(BADGING), signer: parseSigner(SIGNED), apkSha256: 'ab'.repeat(32) });

  assert.match(summary, /Signing certificate SHA-256: `0f1e2d/);
  assert.match(summary, new RegExp(`APK SHA-256: \`${'ab'.repeat(32)}\``));
  for (const permission of ALLOWED_PERMISSIONS.keys()) assert.ok(summary.includes(permission));
  assert.doesNotMatch(summary, /undefined/);
});

test('a release whose shrinker removed a class native code looks up by name is refused', () => {
  // What R8's usage.txt looked like for the release that crashed: the whole class gone.
  assert.deepEqual(
    removedNativeClasses(['androidx.compose.ui.Unused', 'org.jni_zero.JniInit', 'org.jni_zero_like.NotIt'].join('\r\n')),
    ['org.jni_zero.JniInit'],
  );

  // And for the fixed one: only empty static initializers trimmed, and compiler-made helpers. Not a finding.
  const fixed = [
    'org.jni_zero.JniInit:',
    '    static void <clinit>()',
    'org.webrtc.RendererCommon:',
    '    static void <clinit>()',
    'org.webrtc.PeerConnection-IA',
    'org.webrtc.Foo$$ExternalSyntheticLambda0',
  ].join('\n');
  assert.deepEqual(removedNativeClasses(fixed), []);
});
