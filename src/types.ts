export type CapabilityRisk = "READ" | "WRITE_REVERSIBLE" | "WRITE_IRREVERSIBLE";

export type ActionStatus =
  | "AWAITING_APPROVAL"
  | "READY"
  | "IN_PROGRESS"
  | "OUTCOME_UNKNOWN"
  | "SUCCEEDED"
  | "REJECTED"
  | "CANCELLED";

export type CapabilityOutcome =
  | { readonly kind: "SUCCEEDED"; readonly output: unknown }
  | { readonly kind: "REJECTED"; readonly reason: string }
  | { readonly kind: "OUTCOME_UNKNOWN"; readonly reason: string };

export type ReconciliationOutcome =
  | { readonly kind: "CONFIRMED"; readonly output: unknown }
  | { readonly kind: "ABSENT"; readonly evidence: string }
  | { readonly kind: "UNRESOLVED"; readonly evidence: string };

export interface ExecutionContext {
  readonly actionId: string;
  readonly taskId: string;
  readonly requestedBy: string;
  readonly attempt: number;
}

export interface CapabilityDefinition {
  readonly name: string;
  readonly version: string;
  readonly description: string;
  readonly risk: CapabilityRisk;
  readonly validate: (input: unknown) => unknown;
  readonly execute: (
    input: unknown,
    context: ExecutionContext,
  ) => Promise<CapabilityOutcome>;
  readonly reconcile?: (
    input: unknown,
    context: ExecutionContext,
  ) => Promise<ReconciliationOutcome>;
}

export interface ApprovalRecord {
  readonly approvedBy: string;
  readonly approvedAtMs: number;
  readonly expiresAtMs: number;
  readonly inputHash: string;
}

export interface ActionRecord {
  readonly actionId: string;
  readonly taskId: string;
  readonly requestedBy: string;
  readonly capabilityName: string;
  readonly capabilityVersion: string;
  readonly risk: CapabilityRisk;
  readonly input: unknown;
  readonly inputHash: string;
  status: ActionStatus;
  attemptCount: number;
  updatedAtMs: number;
  readonly createdAtMs: number;
  approval?: ApprovalRecord;
  output?: unknown;
  failureReason?: string;
}

export type ProgressEventType =
  | "ACTION_REQUESTED"
  | "REQUEST_DEDUPLICATED"
  | "APPROVAL_REQUIRED"
  | "APPROVED"
  | "APPROVAL_EXPIRED"
  | "EXECUTION_STARTED"
  | "SUCCEEDED"
  | "REJECTED"
  | "OUTCOME_UNKNOWN"
  | "RECONCILIATION_STARTED"
  | "RECONCILIATION_CONFIRMED"
  | "RECONCILIATION_ABSENT"
  | "RECONCILIATION_UNRESOLVED"
  | "CANCELLED";

export interface ProgressEvent {
  readonly ordinal: number;
  readonly actionId: string;
  readonly occurredAtMs: number;
  readonly type: ProgressEventType;
  readonly message: string;
}

export interface DurableSnapshot {
  readonly actions: readonly ActionRecord[];
  readonly events: readonly ProgressEvent[];
}

export interface Clock {
  now(): number;
}
