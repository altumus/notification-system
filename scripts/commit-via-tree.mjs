#!/usr/bin/env node
/**
 * Коммит через write-tree/commit-tree без Co-authored-by trailer.
 *
 * Usage:
 *   node ./scripts/commit-via-tree.mjs "subject" "body..."
 *   # или файлы уже в индексе; иначе передайте пути после --
 *   node ./scripts/commit-via-tree.mjs "subject" "body" -- README.md docs/
 */

import { execFileSync } from 'node:child_process';
import { writeFileSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';

const args = process.argv.slice(2);
const dash = args.indexOf('--');
const messageArgs = dash === -1 ? args : args.slice(0, dash);
const paths = dash === -1 ? [] : args.slice(dash + 1);

const subject = messageArgs[0];
const body = messageArgs.slice(1).join('\n').trim();

if (!subject) {
  console.error('Usage: node ./scripts/commit-via-tree.mjs "subject" ["body"] [-- paths...]');
  process.exit(1);
}

/**
 * @param {string[]} gitArgs
 * @returns {string}
 */
function git(gitArgs) {
  return execFileSync('git', gitArgs, { encoding: 'utf8' }).trim();
}

if (paths.length > 0) {
  git(['add', '--', ...paths]);
} else {
  git(['add', '-u']);
}

const status = git(['status', '--porcelain']);
if (status.length === 0) {
  console.error('Nothing to commit');
  process.exit(1);
}

const msgPath = join('.git', 'COMMIT_MSG_TMP');
const message = body.length > 0 ? `${subject}\n\n${body}\n` : `${subject}\n`;
writeFileSync(msgPath, message, 'utf8');

try {
  const tree = git(['write-tree']);
  const parent = git(['rev-parse', 'HEAD']);
  const commit = git(['commit-tree', tree, '-p', parent, '-F', msgPath]);
  git(['update-ref', 'HEAD', commit]);
  console.log(git(['log', '-1', '--format=%H%n%B']));
} finally {
  try {
    unlinkSync(msgPath);
  } catch {
    // ignore
  }
}
