/**
 * Unit tests for `characterLabel`: the single display-label priority rule
 * shared by the standalone terminal rail and (indirectly) the ToolOverlay
 * name row.
 *
 * Priority: customTitle -> agentName -> terminalName -> "Agent #id". An
 * empty string is "no title" at every level — the renameAgent clear path
 * broadcasts '' and it must fall through, never render as an empty label.
 *
 * Run with: npm run test:webview -- test/character-label.test.ts
 */
import { describe, expect, it } from 'vitest';

import { characterLabel } from '../src/office/engine/characters.js';

describe('characterLabel', () => {
  it('resolves customTitle → agentName → terminalName → Agent #id', () => {
    expect(characterLabel({ id: 3 })).toBe('Agent #3');
    expect(characterLabel({ id: 3, terminalName: 'Claude Code #1' })).toBe('Claude Code #1');
    expect(characterLabel({ id: 3, agentName: 'researcher', terminalName: 'Claude Code #1' })).toBe(
      'researcher',
    );
    expect(characterLabel({ id: 3, customTitle: 'Billing bot', agentName: 'researcher' })).toBe(
      'Billing bot',
    );
  });

  it('treats an empty string as absent at every level', () => {
    expect(characterLabel({ id: 7, customTitle: '', terminalName: 'Claude Code #2' })).toBe(
      'Claude Code #2',
    );
    expect(characterLabel({ id: 7, customTitle: '', agentName: '', terminalName: '' })).toBe(
      'Agent #7',
    );
  });
});
