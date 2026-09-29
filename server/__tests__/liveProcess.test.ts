import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { LIVE_PROCESS_START_TOLERANCE_MS } from '../src/constants.js';
import {
  findLiveProcessIn,
  type LiveProcessDeps,
  parsePsLine,
} from '../src/providers/hook/claude/liveProcess.js';

const SID = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
// Registry procStart strings are UTC without a zone suffix.
const PROC_START = 'Thu Sep 10 18:06:48 2026';
const PROC_START_MS = Date.parse(`${PROC_START} UTC`);

describe('findLiveProcessIn', () => {
  let dir: string;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pxl-live-'));
  });
  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  function writeEntry(pid: number, extra: Record<string, unknown> = {}) {
    fs.writeFileSync(
      path.join(dir, `${pid}.json`),
      JSON.stringify({ pid, sessionId: SID, cwd: '/tmp/proj', procStart: PROC_START, ...extra }),
    );
  }

  function deps(over: Partial<LiveProcessDeps> = {}): LiveProcessDeps {
    return {
      registryDir: dir,
      isAlive: () => true,
      inspect: () => ({ startedAtMs: PROC_START_MS, command: 'claude' }),
      ...over,
    };
  }

  it('returns pid and cwd when registry, liveness, command and start time all agree', () => {
    writeEntry(4242);
    expect(findLiveProcessIn(SID, deps())).toEqual({ pid: 4242, cwd: '/tmp/proj' });
  });

  it('accepts a start time within the tolerance', () => {
    writeEntry(4242);
    const d = deps({
      inspect: () => ({
        startedAtMs: PROC_START_MS + LIVE_PROCESS_START_TOLERANCE_MS - 1,
        command: '/usr/local/bin/claude --resume x',
      }),
    });
    expect(findLiveProcessIn(SID, d)?.pid).toBe(4242);
  });

  it('returns null when no entry names the session', () => {
    writeEntry(4242, { sessionId: 'other' });
    expect(findLiveProcessIn(SID, deps())).toBeNull();
  });

  it('returns null when the pid is dead', () => {
    writeEntry(4242);
    expect(findLiveProcessIn(SID, deps({ isAlive: () => false }))).toBeNull();
  });

  it('returns null when the pid was reused by another command', () => {
    writeEntry(4242);
    const d = deps({ inspect: () => ({ startedAtMs: PROC_START_MS, command: 'node server.js' }) });
    expect(findLiveProcessIn(SID, d)).toBeNull();
  });

  it('returns null when the start time is off by more than the tolerance', () => {
    writeEntry(4242);
    const d = deps({
      inspect: () => ({
        startedAtMs: PROC_START_MS + LIVE_PROCESS_START_TOLERANCE_MS + 1000,
        command: 'claude',
      }),
    });
    expect(findLiveProcessIn(SID, d)).toBeNull();
  });

  it('returns null when ps is unavailable (inspect → null)', () => {
    writeEntry(4242);
    expect(findLiveProcessIn(SID, deps({ inspect: () => null }))).toBeNull();
  });

  it('returns null when the entry has no parsable procStart', () => {
    writeEntry(4242, { procStart: 'yesterday-ish' });
    expect(findLiveProcessIn(SID, deps())).toBeNull();
  });

  it('a stale (dead-pid) entry for the same session does not shadow the live one', () => {
    writeEntry(1111); // crashed earlier; file lingered
    writeEntry(4242);
    const d = deps({ isAlive: (pid) => pid === 4242 });
    expect(findLiveProcessIn(SID, d)?.pid).toBe(4242);
  });

  it('ignores unreadable or non-JSON files and a missing registry dir', () => {
    fs.writeFileSync(path.join(dir, '1.json'), '{not json');
    writeEntry(4242);
    expect(findLiveProcessIn(SID, deps())?.pid).toBe(4242);
    expect(findLiveProcessIn(SID, deps({ registryDir: path.join(dir, 'nope') }))).toBeNull();
  });
});

describe('parsePsLine', () => {
  it('parses "lstart command" output into a local-time epoch and the command', () => {
    const out = parsePsLine('Thu Sep 10 14:06:48 2026 claude --session-id abc');
    expect(out).not.toBeNull();
    expect(out!.command).toBe('claude --session-id abc');
    expect(out!.startedAtMs).toBe(Date.parse('Sep 10 2026 14:06:48'));
  });

  it('handles a space-padded single-digit day and a wide command column', () => {
    const out = parsePsLine('Tue Sep  1 10:09:21 2026     /sbin/launchd');
    expect(out).not.toBeNull();
    expect(out!.command).toBe('/sbin/launchd');
    expect(out!.startedAtMs).toBe(Date.parse('Sep 1 2026 10:09:21'));
  });

  it('returns null for empty or malformed output', () => {
    expect(parsePsLine('')).toBeNull();
    expect(parsePsLine('garbage')).toBeNull();
  });
});
