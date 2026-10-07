import type { AgentAddedExtra } from './agentStateStore.js';
import type { AgentState } from './types.js';

/**
 * The ONE shape of `agentCreated`. httpServer emits it on the store's
 * agentAdded event; undoClose and restoreSession broadcast it explicitly (with
 * the seat to re-take). Keep the field list identical to what the socket
 * closure sent before this module existed — the webview keys on it.
 */
export function agentCreatedMessage(
  id: number,
  agent: AgentState,
  extra?: AgentAddedExtra,
): Record<string, unknown> {
  const msg: Record<string, unknown> = {
    type: 'agentCreated',
    id,
    folderName: agent.folderName,
    isExternal: agent.isExternal || undefined,
    isTeammate: agent.leadAgentId !== undefined || undefined,
    teammateName: agent.agentName,
    parentAgentId: agent.leadAgentId,
    teamName: agent.teamName,
    hooksOnly: agent.hooksOnly || undefined,
    palette: agent.palette,
    hueShift: agent.hueShift,
    ptyBacked: agent.ptyBacked || undefined,
    customTitle: agent.customTitle,
    // Live AgentState has no terminalName field (that only exists on the
    // persisted shape) — source it from terminalRef.name, the same pattern
    // agentStateStore.persist uses.
    terminalName: agent.terminalRef?.name || undefined,
  };
  if (extra?.seatId !== undefined) msg.seatId = extra.seatId;
  if (extra?.restored) msg.restored = true;
  return msg;
}
