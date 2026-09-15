#!/usr/bin/env node
/**
 * Check a release APK before it is published.
 *
 * - Signed with APK Signature Scheme v2 or later, by one signer, and not with an Android debug certificate.
 * - Not debuggable.
 * - Asking for no permission beyond the list below. A dependency that adds one — an advertising id, a
 *   microphone — fails the release instead of shipping in it quietly.
 * - The package, and the version the pipeline meant to build.
 *
 *     node scripts/verify-android-release.mjs <apk> [--version-name 0.2.0] [--version-code 2000] [--summary notes.md]
 *
 * Uses the newest build-tools under ANDROID_HOME (or ANDROID_SDK_ROOT). Prints the APK's SHA-256 and the signing
 * certificate's SHA-256 — public facts a person installing it can compare — and nothing about the key.
 */
import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

export const PACKAGE_NAME = 'app.amizhthan.wolf';

/** Every permission a release may carry, and why it does. */
export const ALLOWED_PERMISSIONS = new Map([
  ['android.permission.INTERNET', 'the WOLF API and the stream'],
  ['android.permission.ACCESS_NETWORK_STATE', 'WebRTC following a move between Wi-Fi and mobile data'],
  ['android.permission.POST_NOTIFICATIONS', 'notifications after a wake-up, when the owner allows them'],
  ['android.permission.WAKE_LOCK', 'Firebase Cloud Messaging, while it hands over a wake-up'],
  ['com.google.android.c2dm.permission.RECEIVE', 'Firebase Cloud Messaging, to receive a wake-up'],
  [`${PACKAGE_NAME}.DYNAMIC_RECEIVER_NOT_EXPORTED_PERMISSION`, "AndroidX's guard on the app's own unexported receivers"],
]);

const lines = (text) => text.replace(/\r\n/g, '\n');

/** `aapt2 dump badging`, as the facts the checks need. */
export function parseBadging(output) {
  const text = lines(output);
  const packageLine = text.split('\n').find((line) => line.startsWith('package:')) ?? '';
  const attribute = (name) => packageLine.match(new RegExp(`\\b${name}='([^']*)'`))?.[1] ?? null;
  return {
    packageName: attribute('name'),
    versionCode: attribute('versionCode'),
    versionName: attribute('versionName'),
    debuggable: /^application-debuggable\s*$/m.test(text),
    permissions: [...text.matchAll(/^uses-permission(?:-sdk-23)?: name='([^']+)'/gm)].map((match) => match[1]),
  };
}

/** `apksigner verify --verbose --print-certs`, as the facts the checks need. */
export function parseSigner(output) {
  const text = lines(output);
  return {
    schemes: [...text.matchAll(/^Verified using (v[\d.]+) scheme[^:\n]*: true$/gm)].map((match) => match[1]),
    signers: [...text.matchAll(/^Signer #\d+ certificate DN:/gm)].length,
    certificateDn: text.match(/^Signer #1 certificate DN: (.+)$/m)?.[1] ?? null,
    certificateSha256: text.match(/^Signer #1 certificate SHA-256 digest: ([0-9a-f]+)$/m)?.[1] ?? null,
  };
}

/** What is wrong with a release, in words. Empty when nothing is. */
export function releaseFindings({ badging, signer, verified, expectedVersionName = null, expectedVersionCode = null }) {
  const findings = [];
  if (!verified) findings.push('The signature does not verify.');
  if (!signer.schemes.some((scheme) => scheme !== 'v1')) {
    findings.push('The APK is not signed with APK Signature Scheme v2 or later.');
  }
  if (signer.signers !== 1) findings.push(`Expected one signer, found ${signer.signers}.`);
  if (/\bCN=Android Debug\b/i.test(signer.certificateDn ?? '')) {
    findings.push('The APK is signed with an Android debug certificate.');
  }
  if (badging.debuggable) findings.push('The APK is debuggable.');
  if (badging.packageName !== PACKAGE_NAME) {
    findings.push(`The package is ${badging.packageName ?? 'unreadable'}, not ${PACKAGE_NAME}.`);
  }
  for (const permission of badging.permissions) {
    if (!ALLOWED_PERMISSIONS.has(permission)) {
      findings.push(`The APK asks for ${permission}, which WOLF has not decided to ask for.`);
    }
  }
  if (expectedVersionName !== null && badging.versionName !== expectedVersionName) {
    findings.push(`The version name is ${badging.versionName}, not ${expectedVersionName}.`);
  }
  if (expectedVersionCode !== null && badging.versionCode !== String(expectedVersionCode)) {
    findings.push(`The version code is ${badging.versionCode}, not ${expectedVersionCode}.`);
  }
  return findings;
}

/** Release notes: what was built, and what someone installing it can check. */
export function releaseSummary({ badging, signer, apkSha256 }) {
  const permissions = badging.permissions.map((permission) => `- \`${permission}\` — ${ALLOWED_PERMISSIONS.get(permission)}`);
  return [
    `## WOLF for Android ${badging.versionName}`,
    '',
    `- Package \`${badging.packageName}\`, version ${badging.versionName} (${badging.versionCode})`,
    `- APK SHA-256: \`${apkSha256}\``,
    `- Signing certificate SHA-256: \`${signer.certificateSha256}\``,
    '',
    'Compare the certificate fingerprint with the one WOLF publishes before installing. Android will not update an',
    'installed WOLF from an APK signed with a different key, so a mismatch is a copy that is not WOLF.',
    '',
    'Permissions:',
    '',
    ...permissions,
    '',
  ].join('\n');
}

function newestBuildTools() {
  const sdk = process.env.ANDROID_HOME ?? process.env.ANDROID_SDK_ROOT;
  if (!sdk) throw new Error('Set ANDROID_HOME to the Android SDK.');
  const root = path.join(sdk, 'build-tools');
  const versions = existsSync(root) ? readdirSync(root).filter((name) => /^\d+\.\d+\.\d+$/.test(name)) : [];
  if (versions.length === 0) throw new Error(`No build-tools under ${root}.`);
  const numeric = (version) => version.split('.').map(Number);
  versions.sort((a, b) => {
    const [x, y] = [numeric(a), numeric(b)];
    return x[0] - y[0] || x[1] - y[1] || x[2] - y[2];
  });
  return path.join(root, versions.at(-1));
}

function run(tool, args) {
  const windows = process.platform === 'win32';
  const options = { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 };
  // apksigner is a batch file on Windows, which only a shell runs; it is given one quoted command line there
  // rather than arguments a shell would concatenate unescaped. The paths come from this script, not its caller's text.
  const result = windows
    ? spawnSync(
        [`"${tool}${path.basename(tool) === 'apksigner' ? '.bat' : '.exe'}"`, ...args.map((arg) => `"${arg}"`)].join(' '),
        { ...options, shell: true },
      )
    : spawnSync(tool, args, options);
  if (result.error) throw result.error;
  return { status: result.status ?? 1, output: `${result.stdout ?? ''}${result.stderr ?? ''}` };
}

function option(args, name) {
  const index = args.indexOf(name);
  return index >= 0 && index + 1 < args.length ? args[index + 1] : null;
}

function main(args) {
  const apk = args[0];
  if (!apk || apk.startsWith('--') || !existsSync(apk)) {
    process.stderr.write('Usage: node scripts/verify-android-release.mjs <apk> [--version-name X] [--version-code N] [--summary file]\n');
    process.exit(2);
  }

  const tools = newestBuildTools();
  const signing = run(path.join(tools, 'apksigner'), ['verify', '--verbose', '--print-certs', apk]);
  const dump = run(path.join(tools, 'aapt2'), ['dump', 'badging', apk]);
  if (dump.status !== 0) {
    process.stderr.write(`aapt2 could not read ${apk}.\n`);
    process.exit(1);
  }

  const badging = parseBadging(dump.output);
  const signer = parseSigner(signing.output);
  const apkSha256 = createHash('sha256').update(readFileSync(apk)).digest('hex');
  const findings = releaseFindings({
    badging,
    signer,
    verified: signing.status === 0,
    expectedVersionName: option(args, '--version-name'),
    expectedVersionCode: option(args, '--version-code'),
  });

  process.stdout.write(
    [
      `package        ${badging.packageName} ${badging.versionName} (${badging.versionCode})`,
      `signature      ${signer.schemes.join(', ') || 'none'}; ${signer.signers} signer(s)`,
      `certificate    ${signer.certificateSha256 ?? 'unreadable'}`,
      `apk sha-256    ${apkSha256}`,
      `debuggable     ${badging.debuggable}`,
      `permissions    ${badging.permissions.join(', ')}`,
      '',
    ].join('\n'),
  );

  const summary = option(args, '--summary');
  if (summary) writeFileSync(summary, releaseSummary({ badging, signer, apkSha256 }), 'utf8');

  if (findings.length > 0) {
    process.stderr.write(`This APK is not releasable:\n${findings.map((finding) => `  - ${finding}`).join('\n')}\n`);
    process.exit(1);
  }
  process.stdout.write('Releasable.\n');
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main(process.argv.slice(2));
}
