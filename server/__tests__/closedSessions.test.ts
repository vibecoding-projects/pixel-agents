import { describe, expect, it, vi } from 'vitest';

import type { StateAdapter } from '../../core/src/adapter.js';
import type { ClosedSession } from '../../core/src/schemas.js';
import { ClosedSessions } from '../src/closedSessions.js';
import { CLOSED_SESSIONS_MAX } from '../src/constants.js';

function rec(sessionId: string, overrides: Partial<ClosedSession> = {}): ClosedSession {
  return {
    sessionId,
    jsonlFile: `/p/${sessionId}.jsonl`,
    projectDir: '/p',
    terminalName: `Claude Code #${sessionId}`,
    railIndex: 0,
    closedAt: 1,
    ...overrides,
  };
}

function adapterWith(initial: ClosedSession[] = []) {
  const saved: ClosedSession[][] = [];
  const adapter = {
    loadAgents: () => [],
    saveAgents: () => {},
    loadSeats: () => ({}),
    saveSeats: () => {},
    loadClosedSessions: () => initial,
    saveClosedSessions: vi.fn((s: ClosedSession[]) => saved.push([...s])),
    loadAgentOrder: () => [],
    saveAgentOrder: () => {},
    getSetting: <T>(_k: string, d: T) => d,
    setSetting: () => {},
  } as unknown as StateAdapter;
  return { adapter, saved };
}

describe('ClosedSessions', () => {
  it('push prepends, dedupes by sessionId (newest wins) and saves', () => {
    const { adapter, saved } = adapterWith();
    const list = new ClosedSessions(adapter);
    list.push(rec('a', { closedAt: 1 }));
    list.push(rec('b', { closedAt: 2 }));
    list.push(rec('a', { closedAt: 3, customTitle: 'again' }));
    expect(list.list().map((r) => r.sessionId)).toEqual(['a', 'b']);
    expect(list.get('a')?.customTitle).toBe('again');
    expect(saved).toHaveLength(3);
  });

  it('trims to CLOSED_SESSIONS_MAX', () => {
    const list = new ClosedSessions(adapterWith().adapter);
    for (let i = 0; i < CLOSED_SESSIONS_MAX + 3; i++) list.push(rec(`s${i}`));
    expect(list.list()).toHaveLength(CLOSED_SESSIONS_MAX);
    expect(list.list()[0].sessionId).toBe(`s${CLOSED_SESSIONS_MAX + 2}`);
  });

  it('remove returns whether something was removed and saves only then', () => {
    const { adapter, saved } = adapterWith();
    const list = new ClosedSessions(adapter);
    list.push(rec('a'));
    expect(list.remove('zzz')).toBe(false);
    expect(saved).toHaveLength(1);
    expect(list.remove('a')).toBe(true);
    expect(saved).toHaveLength(2);
    expect(list.list()).toEqual([]);
  });

  it('dropMatching removes by sessionId OR jsonlFile', () => {
    const list = new ClosedSessions(adapterWith().adapter);
    list.push(rec('a'));
    list.push(rec('b'));
    expect(list.dropMatching({ sessionId: 'other', jsonlFile: '/p/b.jsonl' })).toBe(true);
    expect(list.dropMatching({ sessionId: 'a', jsonlFile: '/elsewhere' })).toBe(true);
    expect(list.dropMatching({ sessionId: 'none', jsonlFile: '/none' })).toBe(false);
    expect(list.list()).toEqual([]);
  });

  it('load reads the adapter; summaries carry no paths', () => {
    const { adapter } = adapterWith([rec('a', { customTitle: 'Zed' })]);
    const list = new ClosedSessions(adapter);
    list.load();
    expect(list.summaries()).toEqual([
      { sessionId: 'a', terminalName: 'Claude Code #a', customTitle: 'Zed', closedAt: 1 },
    ]);
  });

  it('works without an adapter (in-memory only)', () => {
    const list = new ClosedSessions();
    list.load();
    list.push(rec('a'));
    expect(list.list()).toHaveLength(1);
  });
});
