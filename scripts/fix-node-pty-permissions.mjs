/**
 * postinstall: restore the executable bit on node-pty's macOS spawn-helper.
 *
 * npm strips the exec bit from prebuild assets on install, and node-pty's
 * UnixTerminal then fails every pty spawn with `posix_spawnp failed.` — which
 * the standalone server's WS dispatch swallows, so "+ Agent" silently does
 * nothing. (The repo's own dist/node_modules copy was hand-fixed once; this
 * makes every fresh checkout and worktree work without that folklore.)
 *
 * Must never fail an install: missing paths (Windows, Linux, partial
 * installs) and chmod errors are all silent no-ops.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const prebuildsDir = path.join(repoRoot, 'node_modules', 'node-pty', 'prebuilds');

try {
  for (const platform of fs.readdirSync(prebuildsDir)) {
    const helper = path.join(prebuildsDir, platform, 'spawn-helper');
    try {
      const mode = fs.statSync(helper).mode;
      if ((mode & 0o111) === 0) {
        fs.chmodSync(helper, mode | 0o755);
        console.log(`[fix-node-pty-permissions] chmod +x ${path.relative(repoRoot, helper)}`);
      }
    } catch {
      // No spawn-helper for this platform (e.g. win32) — fine.
    }
  }
} catch {
  // node-pty not installed (or no prebuilds dir) — nothing to fix.
}
