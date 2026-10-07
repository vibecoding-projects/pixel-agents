import { describe, expect, it } from 'vitest';
import type * as vscode from 'vscode';

import { agentCreatedMessage } from '../src/agentCreatedMessage.js';
import type { AgentState } from '../src/types.js';

function agent(overrides: Partial<AgentState> = {}): AgentState {
  return {
    id: 5,
    sessionId: 's',
    isExternal: false,
    projectDir: '/p',
    jsonlFile: '/p/s.jsonl',
    fileOffset: 0,
    lineBuffer: '',
    activeToolIds: new Set(),
    activeToolStatuses: new Map(),
    activeToolNames: new Map(),
    activeSubagentToolIds: new Map(),
    activeSubagentToolNames: new Map(),
    backgroundAgentToolIds: new Set(),
    isWaiting: false,
    permissionSent: false,
    hadToolsInTurn: false,
    lastDataAt: 0,
    linesProcessed: 0,
    seenUnknownRecordTypes: new Set(),
    hookDelivered: false,
    contextTokens: 0,
    maxContextTokens: 1,
    ...overrides,
  } as AgentState;
}

describe('agentCreatedMessage', () => {
  it('matches the historical httpServer payload shape with no extra', () => {
    const msg = agentCreatedMessage(
      5,
      agent({
        folderName: 'proj',
        palette: 2,
        hueShift: 90,
        ptyBacked: true,
        customTitle: 'Zed',
        terminalRef: { name: 'Claude Code #3' } as vscode.Terminal,
      }),
    );
    expect(msg).toEqual({
      type: 'agentCreated',
      id: 5,
      folderName: 'proj',
      isExternal: undefined,
      isTeammate: undefined,
      teammateName: undefined,
      parentAgentId: undefined,
      teamName: undefined,
      hooksOnly: undefined,
      palette: 2,
      hueShift: 90,
      ptyBacked: true,
      customTitle: 'Zed',
      terminalName: 'Claude Code #3',
    });
  });

  it('adds seatId/restored only when given', () => {
    const msg = agentCreatedMessage(1, agent(), { seatId: 'chair-1', restored: true });
    expect(msg.seatId).toBe('chair-1');
    expect(msg.restored).toBe(true);
    expect('seatId' in agentCreatedMessage(1, agent())).toBe(false);
    expect('restored' in agentCreatedMessage(1, agent(), { seatId: 'x' })).toBe(false);
  });
});
