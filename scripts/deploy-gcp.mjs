#!/usr/bin/env node
/**
 * Deploy WOLF to the VM that infrastructure/terraform made.
 *
 *     node scripts/deploy-gcp.mjs secrets [--fcm C:\WOLF-secrets\fcm.json]
 *         Make each secret WOLF needs, once, straight into Secret Manager. Values are generated here, handed to
 *         gcloud on its standard input, and never printed, written to a file, or kept in Terraform state.
 *         A secret that already has a value is left alone: a new database password or token secret would lock
 *         WOLF out of its own database and sign everyone out.
 *
 *     node scripts/deploy-gcp.mjs deploy [--allow-uncommitted]
 *         Build both images from this commit, push them, point the VM at them, and restart WOLF there.
 *
 *     node scripts/deploy-gcp.mjs status
 *         What is running on the VM.
 *
 *     node scripts/deploy-gcp.mjs local-secrets
 *         Throwaway secrets in .wolf-local/ for running the production images on this PC
 *         (infrastructure/docker/compose.local.yml).
 *
 * Reads the project, registry and VM from `terraform output`, so run `terraform apply` first.
 * Needs gcloud (signed in), terraform, and Docker Desktop running.
 */
import { randomBytes } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const terraformDir = path.join(root, 'infrastructure', 'terraform');
const windows = process.platform === 'win32';

/** Every secret the VM reads, and how a new value is made. The FCM credentials come from the owner's file. */
export const GENERATED_SECRETS = new Map([
  ['wolf-token-secret', () => randomBytes(48).toString('base64url')],
  ['wolf-database-password', () => randomBytes(32).toString('base64url')],
  ['wolf-turn-secret', () => randomBytes(32).toString('base64url')],
  ['wolf-webhook-key', () => randomBytes(48).toString('base64url')],
]);

function fail(message) {
  process.stderr.write(`\n${message}\n`);
  process.exit(1);
}

/**
 * Run a tool. On Windows gcloud and terraform are .cmd/.ps1 shims that only a shell starts, so the command line is
 * built here with every argument quoted; the arguments come from this script, never from outside text.
 */
function run(tool, args, { input, capture = false, allowFailure = false } = {}) {
  const quoted = (value) => (/^[\w@%+=:,./\\-]+$/.test(value) ? value : `"${value.replace(/"/g, '\\"')}"`);
  const result = spawnSync(windows ? [tool, ...args].map(quoted).join(' ') : tool, windows ? [] : args, {
    cwd: root,
    shell: windows,
    input,
    encoding: 'utf8',
    stdio: [input === undefined ? 'inherit' : 'pipe', capture ? 'pipe' : 'inherit', capture ? 'pipe' : 'inherit'],
    maxBuffer: 64 * 1024 * 1024,
  });
  if (result.error) fail(`Could not run ${tool}: ${result.error.message}`);
  if (result.status !== 0 && !allowFailure) {
    fail(`${tool} ${args[0] ?? ''} failed.${capture ? `\n${result.stderr ?? ''}` : ''}`);
  }
  return { status: result.status ?? 1, stdout: result.stdout ?? '', stderr: result.stderr ?? '' };
}

function terraformOutputs() {
  if (!existsSync(path.join(terraformDir, 'terraform.tfstate'))) {
    fail('No Terraform state yet. Run the steps in docs/operations/deployment.md first (terraform apply).');
  }
  const { stdout } = run('terraform', [`-chdir=${terraformDir}`, 'output', '-json'], { capture: true });
  const outputs = JSON.parse(stdout);
  const value = (name) => outputs[name]?.value;
  const registry = value('registry');
  const instance = value('instance');
  if (!registry || !instance) fail('terraform output is missing registry or instance. Run terraform apply again.');
  const project = registry.split('/')[1];
  const domain = (value('dns_records')?.[0] ?? '').trim().split(/\s+/)[1];
  return { registry, instance, project, domain };
}

function hasVersion(project, secret) {
  const { status, stdout } = run(
    'gcloud',
    ['secrets', 'versions', 'list', secret, `--project=${project}`, '--filter=state=enabled', '--format=value(name)', '--limit=1'],
    { capture: true, allowFailure: true },
  );
  if (status !== 0) fail(`Secret ${secret} was not found. Run terraform apply first.`);
  return stdout.trim().length > 0;
}

function secrets(args) {
  const { project } = terraformOutputs();

  for (const [secret, make] of GENERATED_SECRETS) {
    if (hasVersion(project, secret)) {
      process.stdout.write(`${secret}: already set, left alone\n`);
      continue;
    }
    run('gcloud', ['secrets', 'versions', 'add', secret, `--project=${project}`, '--data-file=-'], {
      input: make(),
      capture: true,
    });
    process.stdout.write(`${secret}: made\n`);
  }

  const fcmIndex = args.indexOf('--fcm');
  if (fcmIndex >= 0) {
    const file = args[fcmIndex + 1];
    if (!file || !existsSync(file)) fail(`--fcm needs the path of the Firebase service-account file.`);
    run('gcloud', ['secrets', 'versions', 'add', 'wolf-fcm-credentials', `--project=${project}`, `--data-file=${file}`], {
      capture: true,
    });
    process.stdout.write('wolf-fcm-credentials: stored\n');
  }
}

function imageTag(allowUncommitted) {
  const dirty = run('git', ['status', '--porcelain', '--untracked-files=no'], { capture: true }).stdout.trim();
  if (dirty && !allowUncommitted) {
    fail('There are uncommitted changes. A deployed image names the commit it was built from; commit first, or pass --allow-uncommitted.');
  }
  const commit = run('git', ['rev-parse', '--short=12', 'HEAD'], { capture: true }).stdout.trim();
  return dirty ? `${commit}-dirty-${Date.now()}` : commit;
}

function deploy(args) {
  const { registry, instance, domain } = terraformOutputs();
  const tag = imageTag(args.includes('--allow-uncommitted'));

  if (run('docker', ['info'], { capture: true, allowFailure: true }).status !== 0) {
    fail('Docker is not running. Open Docker Desktop, wait until it says "Engine running", and try again.');
  }

  run('gcloud', ['auth', 'configure-docker', registry.split('/')[0], '--quiet'], { capture: true });

  process.stdout.write(`\nBuilding the server image (${tag})…\n`);
  run('docker', ['build', '-f', 'infrastructure/docker/server.Dockerfile', '-t', `${registry}/server:${tag}`, '.']);

  process.stdout.write(`\nBuilding the dashboard image for https://${domain}…\n`);
  run('docker', [
    'build',
    '-f', 'infrastructure/docker/web.Dockerfile',
    '--build-arg', `NEXT_PUBLIC_WOLF_API_URL=https://api.${domain}`,
    '--build-arg', `NEXT_PUBLIC_WOLF_REALTIME_URL=wss://relay.${domain}`,
    '-t', `${registry}/web:${tag}`,
    '.',
  ]);

  process.stdout.write('\nPushing…\n');
  run('docker', ['push', `${registry}/server:${tag}`]);
  run('docker', ['push', `${registry}/web:${tag}`]);

  process.stdout.write('\nPointing the VM at the new images and restarting WOLF there…\n');
  run('gcloud', [
    'compute', 'instances', 'add-metadata', instance.name,
    `--zone=${instance.zone}`,
    `--metadata=wolf-image-tag=${tag}`,
  ]);
  run('gcloud', [
    'compute', 'ssh', instance.name,
    `--zone=${instance.zone}`,
    '--tunnel-through-iap',
    '--command=sudo google_metadata_script_runner startup',
  ]);

  process.stdout.write(`\nDeployed ${tag}. Open https://${domain} (the first start takes a minute).\n`);
}

function status() {
  const { instance } = terraformOutputs();
  run('gcloud', [
    'compute', 'ssh', instance.name,
    `--zone=${instance.zone}`,
    '--tunnel-through-iap',
    '--command=sudo docker ps --format "table {{.Names}}\\t{{.Status}}\\t{{.Image}}"',
  ]);
}

function localSecrets() {
  const dir = path.join(root, '.wolf-local');
  mkdirSync(path.join(dir, 'secrets'), { recursive: true });
  const password = GENERATED_SECRETS.get('wolf-database-password')();
  writeFileSync(path.join(dir, 'database-password'), password, { mode: 0o600 });
  writeFileSync(
    path.join(dir, 'server.env'),
    [
      'NODE_ENV=production',
      'HOST=0.0.0.0',
      `DATABASE_URL=postgres://wolf:${password}@db:5432/wolf`,
      'DATABASE_SSL=disable',
      `WOLF_TOKEN_SECRET=${GENERATED_SECRETS.get('wolf-token-secret')()}`,
      'WOLF_TOKEN_ISSUER=http://localhost:8080',
      'WOLF_ALLOWED_ORIGINS=http://localhost:3000',
      `WOLF_WEBHOOK_KEY=${GENERATED_SECRETS.get('wolf-webhook-key')()}`,
      '',
    ].join('\n'),
    { mode: 0o600 },
  );
  process.stdout.write(`Throwaway local secrets written to ${dir} (ignored by git). They are for this PC only.\n`);
}

const [command, ...rest] = process.argv.slice(2);
if (process.argv[1] && import.meta.url === new URL(`file:///${path.resolve(process.argv[1]).replace(/\\/g, '/')}`).href) {
  switch (command) {
    case 'secrets':
      secrets(rest);
      break;
    case 'deploy':
      deploy(rest);
      break;
    case 'status':
      status();
      break;
    case 'local-secrets':
      localSecrets();
      break;
    default:
      process.stderr.write('Usage: node scripts/deploy-gcp.mjs secrets [--fcm <file>] | deploy [--allow-uncommitted] | status | local-secrets\n');
      process.exit(2);
  }
}
