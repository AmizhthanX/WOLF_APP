#!/usr/bin/env node
/**
 * Remove build output across the monorepo.
 *
 * Deliberately conservative: it removes only known build directories inside workspaces,
 * never `node_modules` and never anything it was not told about by name. A clean script
 * that guesses is a clean script that eventually deletes source.
 */
import { rm, readdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/** Directories inside a workspace that hold generated output. */
const BUILD_DIRECTORIES = ['dist', 'dist-test', '.next', 'bin', 'obj', 'coverage'];

/** Workspace roots to sweep. */
const WORKSPACE_ROOTS = ['packages', 'services', 'apps', 'windows'];

const removed = [];

async function sweep(workspace) {
  for (const directory of BUILD_DIRECTORIES) {
    const target = path.join(workspace, directory);
    try {
      await rm(target, { recursive: true, force: true });
      removed.push(path.relative(root, target).split(path.sep).join('/'));
    } catch {
      // Nothing there, which is the normal case.
    }
  }

  // .NET projects nest one level deeper (windows/agent/Wolf.Agent.Core).
  let entries;
  try {
    entries = await readdir(workspace, { withFileTypes: true });
  } catch {
    return;
  }

  for (const entry of entries) {
    if (!entry.isDirectory() || entry.name === 'node_modules' || entry.name.startsWith('.')) {
      continue;
    }
    for (const directory of BUILD_DIRECTORIES) {
      await rm(path.join(workspace, entry.name, directory), { recursive: true, force: true });
    }
  }
}

for (const workspaceRoot of WORKSPACE_ROOTS) {
  let entries;
  try {
    entries = await readdir(path.join(root, workspaceRoot), { withFileTypes: true });
  } catch {
    continue;
  }

  for (const entry of entries) {
    if (entry.isDirectory()) {
      await sweep(path.join(root, workspaceRoot, entry.name));
    }
  }
}

// TypeScript project references leave build info at the repository root too.
await rm(path.join(root, 'tsconfig.tsbuildinfo'), { force: true });

process.stdout.write(`Cleaned ${removed.length} build directories.\n`);
