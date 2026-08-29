import { actionInputHash } from "./stableJson.js";
import { InMemoryDurableStore } from "./store.js";
import type {
  ActionRecord,
  CapabilityDefinition,
  Clock,
  ExecutionContext,
  ProgressEvent,
  ProgressEventType,
} from "./types.js";

export interface RequestActionInput {
  readonly actionId: string;
  readonly taskId: string;
  readonly requestedBy: string;
  readonly capabilityName: string;
  readonly input: unknown;
}

export interface CoordinatorOptions {
  readonly approvalTtlMs?: number;
}

const systemClock: Clock = { now: () => Date.now() };

export class DurableActionCoordinator {
  private readonly capabilities = new Map<string, CapabilityDefinition>();
  private readonly approvalTtlMs: number;

  constructor(
    private readonly store: InMemoryDurableStore,
    private readonly clock: Clock = systemClock,
    options: CoordinatorOptions = {},
  ) {
    this.approvalTtlMs = options.approvalTtlMs ?? 5 * 60 * 1_000;
    if (!Number.isSafeInteger(this.approvalTtlMs) || this.approvalTtlMs <= 0) {
      throw new Error("approval TTL must be a positive finite safe integer");
    }
  }

  register(capability: CapabilityDefinition): void {
    if (this.capabilities.has(capability.name)) {
      throw new Error(`capability ${capability.name} is already registered`);
    }
    this.capabilities.set(capability.name, capability);
  }

  requestAction(input: RequestActionInput): { created: boolean; action: ActionRecord } {
    this.assertIdentifier(input.actionId, "action ID");
    this.assertIdentifier(input.taskId, "task ID");
    const requestedBy = this.normalizeActor(input.requestedBy, "requester");
    const capability = this.requireCapability(input.capabilityName);
    const validatedInput = capability.validate(input.input);
    const inputHash = actionInputHash(
      capability.name,
      capability.version,
      validatedInput,
    );
    const existing = this.store.getAction(input.actionId);
    if (existing !== undefined) {
      if (
        existing.taskId !== input.taskId ||
        existing.requestedBy !== requestedBy ||
        existing.capabilityName !== capability.name ||
        existing.capabilityVersion !== capability.version ||
        existing.inputHash !== inputHash
      ) {
        throw new Error("action ID was reused with a different request");
      }
      this.event(existing, "REQUEST_DEDUPLICATED", "identical request already exists");
      return { created: false, action: existing };
    }

    const now = this.clock.now();
    const approvalRequired = capability.risk !== "READ";
    const action: ActionRecord = {
      actionId: input.actionId,
      taskId: input.taskId,
      requestedBy,
      capabilityName: capability.name,
      capabilityVersion: capability.version,
      risk: capability.risk,
      input: validatedInput,
      inputHash,
      status: approvalRequired ? "AWAITING_APPROVAL" : "READY",
      attemptCount: 0,
      createdAtMs: now,
      updatedAtMs: now,
    };
    this.store.saveAction(action);
    this.event(action, "ACTION_REQUESTED", `${capability.name}@${capability.version}`);
    if (approvalRequired) {
      this.event(action, "APPROVAL_REQUIRED", `${capability.risk} capability`);
    }
    return { created: true, action: this.getAction(action.actionId) };
  }

  approveAction(actionId: string, approvedBy: string, inputHash: string): ActionRecord {
    const normalizedApprover = this.normalizeActor(approvedBy, "approver");
    const action = this.requireAction(actionId);
    if (action.status !== "AWAITING_APPROVAL") {
      throw new Error(`cannot approve an action in ${action.status} state`);
    }
    if (normalizedApprover === action.requestedBy) {
      throw new Error("requester cannot approve their own write action");
    }
    if (inputHash !== action.inputHash) {
      throw new Error("approval does not match the immutable action payload");
    }

    const now = this.clock.now();
    const expiresAtMs = now + this.approvalTtlMs;
    if (!Number.isSafeInteger(now) || !Number.isSafeInteger(expiresAtMs)) {
      throw new Error("approval clock and expiry must be finite safe integers");
    }
    action.approval = {
      approvedBy: normalizedApprover,
      approvedAtMs: now,
      expiresAtMs,
      inputHash,
    };
    action.status = "READY";
    action.updatedAtMs = now;
    this.store.saveAction(action);
    this.event(action, "APPROVED", `approved by ${normalizedApprover}`);
    return this.getAction(actionId);
  }

  async execute(actionId: string): Promise<ActionRecord> {
    const action = this.requireAction(actionId);
    const capability = this.requireActionCapability(action);
    if (action.status !== "READY") {
      throw new Error(`cannot execute an action in ${action.status} state`);
    }
    if (action.risk !== "READ") this.requireCurrentApproval(action);

    action.status = "IN_PROGRESS";
    action.attemptCount += 1;
    action.updatedAtMs = this.clock.now();
    delete action.failureReason;
    this.store.saveAction(action);
    this.event(action, "EXECUTION_STARTED", `attempt ${action.attemptCount}`);

    const context = this.context(action);
    let outcome;
    try {
      outcome = await capability.execute(action.input, context);
    } catch (error: unknown) {
      const reason = error instanceof Error ? error.message : "unknown adapter error";
      outcome = {
        kind: "OUTCOME_UNKNOWN" as const,
        reason: `adapter threw after execution began: ${reason}`,
      };
    }

    action.updatedAtMs = this.clock.now();
    if (outcome.kind === "SUCCEEDED") {
      action.status = "SUCCEEDED";
      action.output = outcome.output;
      this.store.saveAction(action);
      this.event(action, "SUCCEEDED", "external effect confirmed");
    } else if (outcome.kind === "REJECTED") {
      action.status = "REJECTED";
      action.failureReason = outcome.reason;
      this.store.saveAction(action);
      this.event(action, "REJECTED", outcome.reason);
    } else {
      action.status = "OUTCOME_UNKNOWN";
      action.failureReason = outcome.reason;
      this.store.saveAction(action);
      this.event(action, "OUTCOME_UNKNOWN", outcome.reason);
    }
    return this.getAction(actionId);
  }

  async reconcile(actionId: string): Promise<ActionRecord> {
    const action = this.requireAction(actionId);
    if (action.status !== "OUTCOME_UNKNOWN") {
      throw new Error(`cannot reconcile an action in ${action.status} state`);
    }
    const capability = this.requireActionCapability(action);
    if (capability.reconcile === undefined) {
      throw new Error(`capability ${capability.name} does not support reconciliation`);
    }

    this.event(action, "RECONCILIATION_STARTED", "checking authoritative external state");
    let outcome;
    try {
      outcome = await capability.reconcile(action.input, this.context(action));
    } catch (error: unknown) {
      const reason = error instanceof Error ? error.message : "unknown reconciliation error";
      outcome = { kind: "UNRESOLVED" as const, evidence: reason };
    }

    action.updatedAtMs = this.clock.now();
    if (outcome.kind === "CONFIRMED") {
      action.status = "SUCCEEDED";
      action.output = outcome.output;
      delete action.failureReason;
      this.store.saveAction(action);
      this.event(action, "RECONCILIATION_CONFIRMED", "external effect found");
    } else if (outcome.kind === "ABSENT") {
      const approvalExpired =
        action.risk !== "READ" &&
        (action.approval === undefined || action.approval.expiresAtMs <= this.clock.now());
      action.status = approvalExpired ? "AWAITING_APPROVAL" : "READY";
      action.failureReason = outcome.evidence;
      this.store.saveAction(action);
      this.event(action, "RECONCILIATION_ABSENT", outcome.evidence);
    } else {
      action.failureReason = outcome.evidence;
      this.store.saveAction(action);
      this.event(action, "RECONCILIATION_UNRESOLVED", outcome.evidence);
    }
    return this.getAction(actionId);
  }

  cancel(actionId: string, requestedBy: string): ActionRecord {
    const normalizedRequester = this.normalizeActor(requestedBy, "cancelling user");
    const action = this.requireAction(actionId);
    if (action.status !== "AWAITING_APPROVAL" && action.status !== "READY") {
      throw new Error(`cannot cancel an action in ${action.status} state`);
    }
    if (
      normalizedRequester !== action.requestedBy &&
      normalizedRequester !== action.approval?.approvedBy
    ) {
      throw new Error("cancelling user is not authorized for this action");
    }
    action.status = "CANCELLED";
    action.updatedAtMs = this.clock.now();
    this.store.saveAction(action);
    this.event(action, "CANCELLED", `cancelled by ${normalizedRequester}`);
    return this.getAction(actionId);
  }

  getAction(actionId: string): ActionRecord {
    return this.requireAction(actionId);
  }

  events(actionId?: string): readonly ProgressEvent[] {
    return this.store.events(actionId);
  }

  private requireCurrentApproval(action: ActionRecord): void {
    const approval = action.approval;
    if (approval === undefined || approval.inputHash !== action.inputHash) {
      throw new Error("write action does not have a matching approval");
    }
    if (approval.expiresAtMs <= this.clock.now()) {
      action.status = "AWAITING_APPROVAL";
      action.updatedAtMs = this.clock.now();
      this.store.saveAction(action);
      this.event(action, "APPROVAL_EXPIRED", "write approval expired before execution");
      throw new Error("write approval expired before execution");
    }
  }

  private context(action: ActionRecord): ExecutionContext {
    return {
      actionId: action.actionId,
      taskId: action.taskId,
      requestedBy: action.requestedBy,
      attempt: action.attemptCount,
    };
  }

  private event(
    action: ActionRecord,
    type: ProgressEventType,
    message: string,
  ): void {
    this.store.appendEvent({
      actionId: action.actionId,
      occurredAtMs: this.clock.now(),
      type,
      message,
    });
  }

  private requireCapability(name: string): CapabilityDefinition {
    const capability = this.capabilities.get(name);
    if (capability === undefined) throw new Error(`unknown capability ${name}`);
    return capability;
  }

  private requireActionCapability(action: ActionRecord): CapabilityDefinition {
    const capability = this.requireCapability(action.capabilityName);
    if (capability.version !== action.capabilityVersion) {
      throw new Error(
        `capability ${action.capabilityName}@${action.capabilityVersion} is unavailable`,
      );
    }
    return capability;
  }

  private requireAction(actionId: string): ActionRecord {
    const action = this.store.getAction(actionId);
    if (action === undefined) throw new Error(`unknown action ${actionId}`);
    return action;
  }

  private assertIdentifier(value: string, label: string): void {
    if (value.trim() === "") throw new Error(`${label} is required`);
  }

  private normalizeActor(value: string, label: string): string {
    const normalized = value.normalize("NFKC").trim().toLowerCase();
    if (normalized === "") throw new Error(`${label} is required`);
    return normalized;
  }
}
