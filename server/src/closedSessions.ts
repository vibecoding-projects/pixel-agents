import type { StateAdapter } from '../../core/src/adapter.js';
import type { ClosedSessionSummary } from '../../core/src/messages.js';
import type { ClosedSession } from '../../core/src/schemas.js';
import { CLOSED_SESSIONS_MAX } from './constants.js';

/**
 * The Closed list: in-office sessions whose close grace window elapsed. Kept
 * so the user can restore one later (claude --resume on its transcript).
 * Newest first, capped, persisted through the adapter on every change.
 * `AgentRuntime.finalizeClose` is the only writer; every other removal path
 * never lands here.
 */
export class ClosedSessions {
  private records: ClosedSession[] = [];

  constructor(private readonly adapter?: StateAdapter) {}

  load(): void {
    this.records = this.adapter?.loadClosedSessions() ?? [];
  }

  list(): ClosedSession[] {
    return [...this.records];
  }

  /** What travels on the wire: no paths. */
  summaries(): ClosedSessionSummary[] {
    return this.records.map((r) => ({
      sessionId: r.sessionId,
      terminalName: r.terminalName,
      customTitle: r.customTitle,
      closedAt: r.closedAt,
    }));
  }

  get(sessionId: string): ClosedSession | undefined {
    return this.records.find((r) => r.sessionId === sessionId);
  }

  push(record: ClosedSession): void {
    this.records = [record, ...this.records.filter((r) => r.sessionId !== record.sessionId)].slice(
      0,
      CLOSED_SESSIONS_MAX,
    );
    this.save();
  }

  remove(sessionId: string): boolean {
    const before = this.records.length;
    this.records = this.records.filter((r) => r.sessionId !== sessionId);
    if (this.records.length === before) return false;
    this.save();
    return true;
  }

  /** A session that is live again (adopted from outside, resumed elsewhere)
   *  must not stay restorable: a second --resume on it would fork the transcript. */
  dropMatching(agent: { sessionId: string; jsonlFile: string }): boolean {
    const before = this.records.length;
    this.records = this.records.filter(
      (r) => r.sessionId !== agent.sessionId && r.jsonlFile !== agent.jsonlFile,
    );
    if (this.records.length === before) return false;
    this.save();
    return true;
  }

  private save(): void {
    try {
      this.adapter?.saveClosedSessions(this.records);
    } catch (err) {
      console.error('[Pixel Agents] Failed to save closed sessions:', err);
    }
  }
}
