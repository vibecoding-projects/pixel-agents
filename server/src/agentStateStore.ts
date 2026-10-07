import { EventEmitter } from 'node:events';
import { appendFileSync } from 'node:fs';

import type { StateAdapter } from '../../core/src/adapter.js';
import type { AgentState, PersistedAgent } from './types.js';

/**
 * CI / e2e diagnostics: when PIXEL_AGENTS_DEBUG_LOG points to a writable
 * path, every broadcast is appended there with a timestamp. The test fixture
 * attaches the resulting file to Allure so failures can be analyzed without
 * local repro. Zero cost when the env var is unset.
 */
const DEBUG_LOG_PATH = process.env['PIXEL_AGENTS_DEBUG_LOG'];

function debugLogBroadcast(message: Record<string, unknown>): void {
  if (!DEBUG_LOG_PATH) return;
  try {
    const t = message.type as string;
    const id = message.id;
    const extras: string[] = [];
    if (id !== undefined) extras.push(`id=${id}`);
    if ('toolName' in message) extras.push(`toolName=${message.toolName}`);
    if ('status' in message) extras.push(`status=${message.status}`);
    if ('parentToolId' in message) extras.push(`parentToolId=${message.parentToolId}`);
    if ('toolId' in message) extras.push(`toolId=${message.toolId}`);
    appendFileSync(DEBUG_LOG_PATH, `${new Date().toISOString()} BCAST ${t} ${extras.join(' ')}\n`);
  } catch {
    /* never crash on diagnostic failure */
  }
}

/** Optional detail riding on agentAdded: set by undo/restore so the single
 *  agentCreated the client sees carries the seat to re-take. */
export interface AgentAddedExtra {
  seatId?: string;
  restored?: boolean;
}

/** Typed event map for AgentStateStore. */
export interface StoreEvents {
  agentAdded: (id: number, agent: AgentState, extra?: AgentAddedExtra) => void;
  agentRemoved: (id: number) => void;
  agentUpdated: (id: number, agent: AgentState, field: string) => void;
  broadcast: (message: Record<string, unknown>) => void;
}

/**
 * Centralized owner of the agents Map. Wraps a private Map<number, AgentState>
 * and exposes Map-compatible read/write methods. Emits typed events on
 * set()/delete() for reactive state changes.
 */
export class AgentStateStore {
  private readonly agents = new Map<number, AgentState>();
  private readonly emitter = new EventEmitter();
  readonly nextAgentId = { current: 1 };
  readonly nextTerminalIndex = { current: 1 };
  private adapter: StateAdapter | undefined;
  /** Rail order: top-level agent ids, top to bottom. May hold stale ids; readers filter. */
  private order: number[] = [];

  // ── Adapter ──────────────────────────────────────────────────

  setAdapter(adapter: StateAdapter): void {
    this.adapter = adapter;
    // Own copy: the adapter's array is never shared with anyone else.
    this.order = [...adapter.loadAgentOrder()];
  }

  // ── Rail order ──────────────────────────────────────────────

  get agentOrder(): number[] {
    return [...this.order];
  }

  private static isTopLevel(agent: AgentState): boolean {
    return agent.leadAgentId === undefined && !agent.spawnToolUseId;
  }

  /** Apply a client-supplied order: keep known top-level ids (first occurrence),
   *  append current top-level agents the client omitted, persist. */
  reorder(order: number[]): number[] {
    const current = [...this.agents.values()].filter(AgentStateStore.isTopLevel).map((a) => a.id);
    const currentSet = new Set(current);
    const next: number[] = [];
    for (const id of order) {
      if (currentSet.has(id) && !next.includes(id)) next.push(id);
    }
    for (const id of current) if (!next.includes(id)) next.push(id);
    this.order = next;
    this.saveOrder();
    return this.agentOrder;
  }

  /** Negative index = unknown position = append (a Closed record whose rail
   *  index was never known must not jump to the top on restore). */
  insertInOrder(id: number, index: number): void {
    this.order = this.order.filter((v) => v !== id);
    const at = index < 0 ? this.order.length : Math.min(index, this.order.length);
    this.order.splice(at, 0, id);
    this.saveOrder();
  }

  private saveOrder(): void {
    try {
      this.adapter?.saveAgentOrder(this.order);
    } catch (err) {
      console.error('[Pixel Agents] Failed to save agent order:', err);
    }
  }

  getAdapter(): StateAdapter | undefined {
    return this.adapter;
  }

  // ── Map-compatible read ──────────────────────────────────────

  get(id: number): AgentState | undefined {
    return this.agents.get(id);
  }

  has(id: number): boolean {
    return this.agents.has(id);
  }

  get size(): number {
    return this.agents.size;
  }

  keys(): MapIterator<number> {
    return this.agents.keys();
  }

  values(): MapIterator<AgentState> {
    return this.agents.values();
  }

  entries(): MapIterator<[number, AgentState]> {
    return this.agents.entries();
  }

  forEach(
    cb: (agent: AgentState, id: number, map: Map<number, AgentState>) => void,
    thisArg?: unknown,
  ): void {
    this.agents.forEach(cb, thisArg);
  }

  [Symbol.iterator](): MapIterator<[number, AgentState]> {
    return this.agents[Symbol.iterator]();
  }

  // ── Event subscription ───────────────────────────────────────

  on<K extends keyof StoreEvents>(event: K, listener: StoreEvents[K]): this {
    this.emitter.on(event, listener as (...args: unknown[]) => void);
    return this;
  }

  off<K extends keyof StoreEvents>(event: K, listener: StoreEvents[K]): this {
    this.emitter.off(event, listener as (...args: unknown[]) => void);
    return this;
  }

  // ── Map-compatible write (emits events) ─────────────────────

  set(id: number, agent: AgentState, extra?: AgentAddedExtra): this {
    const isNew = !this.agents.has(id);
    this.agents.set(id, agent);
    if (isNew) {
      if (AgentStateStore.isTopLevel(agent) && !this.order.includes(id)) this.order.push(id);
      // No trailing undefined on the plain path: the event shape every
      // existing listener sees is unchanged.
      if (extra) this.emitter.emit('agentAdded', id, agent, extra);
      else this.emitter.emit('agentAdded', id, agent);
    }
    return this;
  }

  delete(id: number): boolean {
    const existed = this.agents.delete(id);
    if (existed) {
      this.order = this.order.filter((v) => v !== id);
      this.emitter.emit('agentRemoved', id);
    }
    return existed;
  }

  clear(): void {
    this.agents.clear();
  }

  // ── Broadcast (replaces direct webview.postMessage in server/) ─

  broadcast(message: Record<string, unknown>): void {
    debugLogBroadcast(message);
    this.emitter.emit('broadcast', message);
  }

  // ── Lifecycle ───────────────────────────────────────────────

  dispose(): void {
    this.emitter.removeAllListeners();
  }

  // ── Persistence ─────────────────────────────────────────────

  persist(): void {
    if (!this.adapter) {
      return;
    }
    const persisted: PersistedAgent[] = [];
    for (const agent of this.agents.values()) {
      // Background-spawn children are derived state: the 1s scan re-materializes
      // them from sidecars after a restore. Persisting them would resurrect
      // immortal characters whose completion signal never comes.
      if (agent.spawnToolUseId) continue;
      persisted.push({
        id: agent.id,
        sessionId: agent.sessionId,
        terminalName: agent.terminalRef?.name ?? '',
        isExternal: agent.isExternal || undefined,
        jsonlFile: agent.jsonlFile,
        projectDir: agent.projectDir,
        folderName: agent.folderName,
        teamName: agent.teamName,
        agentName: agent.agentName,
        isTeamLead: agent.isTeamLead,
        leadAgentId: agent.leadAgentId,
        teamUsesTmux: agent.teamUsesTmux,
        backgroundAgentToolIds:
          agent.backgroundAgentToolIds.size > 0 ? [...agent.backgroundAgentToolIds] : undefined,
        palette: agent.palette,
        hueShift: agent.hueShift,
        ptyBacked: agent.ptyBacked || undefined,
        customTitle: agent.customTitle,
        spawnCwd: agent.spawnCwd,
        bypassPermissions: agent.bypassPermissions || undefined,
      });
    }
    this.adapter.saveAgents(persisted);
    this.saveOrder();
  }

  loadPersistedAgents(): PersistedAgent[] {
    return this.adapter?.loadAgents() ?? [];
  }
}
