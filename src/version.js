import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

const git = args => { try { return execFileSync('git', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim(); } catch { return 'unknown'; } };
export function buildVersion() {
  const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url)));
  const sha = git(['rev-parse', '--short', 'HEAD']), branch = git(['branch', '--show-current']);
  const dirty = git(['status', '--porcelain']) !== '';
  return { app_version: pkg.version, commit: sha, branch, dirty, reproducible_version: `${sha}${dirty ? '-dirty' : ''}` };
}
