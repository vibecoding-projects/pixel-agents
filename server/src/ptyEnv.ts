/**
 * Environment for a claude process spawned in an in-office pty.
 *
 * The daemon may itself be running inside a Claude Code session (a terminal
 * opened from one, an agent that started it). A child `claude` that inherits
 * that session's variables (`CLAUDECODE`, `CLAUDE_CODE_SESSION_ID`,
 * `CLAUDE_CODE_CHILD_SESSION`, the messaging socket, …) becomes a CHILD
 * session of it: it writes no top-level transcript, so it can never be
 * resumed, moved, or restored. Every pty spawn goes through here.
 */
const NESTED_SESSION_PREFIX = 'CLAUDE_CODE_';
const NESTED_SESSION_FLAG = 'CLAUDECODE';

export function ptyEnvironment(
  base: NodeJS.ProcessEnv,
  extra?: Record<string, string>,
): Record<string, string | undefined> {
  const env: Record<string, string | undefined> = {};
  for (const [key, value] of Object.entries(base)) {
    if (key === NESTED_SESSION_FLAG || key.startsWith(NESTED_SESSION_PREFIX)) continue;
    env[key] = value;
  }
  return { ...env, ...extra };
}
