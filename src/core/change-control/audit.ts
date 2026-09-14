export type AuditEventType =
  | "APPROVAL_REQUESTED"
  | "APPROVED"
  | "REJECTED"
  | "CHANGE_LOCKED"
  | "CHANGE_AUTHORIZED"
  | "CHANGE_READY"
  | "CHANGE_APPLIED"
  | "CHANGE_BLOCKED";

export interface AuditEvent {
  id: string;
  type: AuditEventType;
  actorId: string;
  targetId: string;
  message: string;
  createdAt: string;
}

export class AuditTrail {
  private readonly events: AuditEvent[] = [];

  append(
    type: AuditEventType,
    actorId: string,
    targetId: string,
    message: string,
  ): AuditEvent {
    const event: AuditEvent = {
      id: `audit_${crypto.randomUUID()}`,
      type,
      actorId,
      targetId,
      message,
      createdAt:
        new Date().toISOString(),
    };

    this.events.push(
      Object.freeze(event),
    );

    return event;
  }

  list(): readonly AuditEvent[] {
    return [...this.events];
  }
}
