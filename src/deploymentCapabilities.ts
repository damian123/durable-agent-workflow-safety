import { z } from "zod";
import type {
  CapabilityDefinition,
  CapabilityOutcome,
  ExecutionContext,
  ReconciliationOutcome,
} from "./types.js";

const inspectInputSchema = z
  .object({
    project: z.string().min(1),
    deploymentId: z.string().min(1),
  })
  .strict();

const rollbackInputSchema = z
  .object({
    project: z.string().min(1),
    deploymentId: z.string().min(1),
    fromRevision: z.string().min(1),
    toRevision: z.string().min(1),
    reason: z.string().min(8),
  })
  .strict()
  .refine((input) => input.fromRevision !== input.toRevision, {
    message: "rollback target must differ from the current revision",
  });

export type InspectDeploymentInput = z.infer<typeof inspectInputSchema>;
export type RollbackDeploymentInput = z.infer<typeof rollbackInputSchema>;

export type RollbackMode =
  | "SUCCEED"
  | "REJECT"
  | "UNKNOWN_APPLIED"
  | "UNKNOWN_ABSENT";

interface RollbackAttemptEvidence {
  readonly input: RollbackDeploymentInput;
  readonly attempt: number;
  readonly disposition: "APPLIED" | "ABSENT";
}

export class ScriptedDeploymentGateway {
  private readonly revisions = new Map<string, Map<string, string>>();
  private readonly modes = new Map<string, RollbackMode>();
  private readonly executions = new Map<string, number>();
  private readonly actionBindings = new Map<string, RollbackDeploymentInput>();
  private readonly attempts = new Map<string, Map<number, RollbackAttemptEvidence>>();

  seed(project: string, deploymentId: string, revision: string): void {
    let deployments = this.revisions.get(project);
    if (deployments === undefined) {
      deployments = new Map<string, string>();
      this.revisions.set(project, deployments);
    }
    deployments.set(deploymentId, revision);
  }

  setMode(actionId: string, mode: RollbackMode): void {
    this.modes.set(actionId, mode);
  }

  executionCount(actionId: string): number {
    return this.executions.get(actionId) ?? 0;
  }

  currentRevision(project: string, deploymentId: string): string | undefined {
    return this.revisions.get(project)?.get(deploymentId);
  }

  async inspect(input: InspectDeploymentInput): Promise<CapabilityOutcome> {
    const revision = this.currentRevision(input.project, input.deploymentId);
    if (revision === undefined) {
      return { kind: "REJECTED", reason: "deployment was not found" };
    }
    return {
      kind: "SUCCEEDED",
      output: { ...input, revision },
    };
  }

  async rollback(
    input: RollbackDeploymentInput,
    context: ExecutionContext,
  ): Promise<CapabilityOutcome> {
    this.bindAction(context.actionId, input);
    this.executions.set(context.actionId, this.executionCount(context.actionId) + 1);
    const current = this.currentRevision(input.project, input.deploymentId);
    if (current === input.toRevision) {
      this.recordAttempt(input, context, "APPLIED");
      return {
        kind: "SUCCEEDED",
        output: { ...input, revision: current, idempotentReplay: true },
      };
    }
    if (current !== input.fromRevision) {
      return {
        kind: "REJECTED",
        reason: `expected ${input.fromRevision}, observed ${current ?? "missing"}`,
      };
    }

    const mode = this.modes.get(context.actionId) ?? "SUCCEED";
    if (mode === "REJECT") {
      return { kind: "REJECTED", reason: "deployment control plane rejected rollback" };
    }
    if (mode === "UNKNOWN_ABSENT") {
      this.recordAttempt(input, context, "ABSENT");
      return {
        kind: "OUTCOME_UNKNOWN",
        reason: "connection closed before the control plane acknowledged the command",
      };
    }

    this.seed(input.project, input.deploymentId, input.toRevision);
    this.recordAttempt(input, context, "APPLIED");
    if (mode === "UNKNOWN_APPLIED") {
      return {
        kind: "OUTCOME_UNKNOWN",
        reason: "connection closed after the command may have been accepted",
      };
    }
    return {
      kind: "SUCCEEDED",
      output: { ...input, revision: input.toRevision, idempotentReplay: false },
    };
  }

  async reconcile(
    input: RollbackDeploymentInput,
    context: ExecutionContext,
  ): Promise<ReconciliationOutcome> {
    const binding = this.actionBindings.get(context.actionId);
    if (binding === undefined || !this.sameRollback(binding, input)) {
      return {
        kind: "UNRESOLVED",
        evidence: `no immutable command binding for action ${context.actionId}`,
      };
    }
    const attempt = this.attempts.get(context.actionId)?.get(context.attempt);
    if (attempt === undefined || !this.sameRollback(attempt.input, input)) {
      return {
        kind: "UNRESOLVED",
        evidence: `no action-correlated evidence for attempt ${context.attempt}`,
      };
    }
    const current = this.currentRevision(input.project, input.deploymentId);
    if (attempt.disposition === "APPLIED") {
      return {
        kind: "CONFIRMED",
        output: {
          ...input,
          revision: input.toRevision,
          observedRevision: current,
          reconciled: true,
          executionAttempt: context.attempt,
        },
      };
    }
    if (current === input.fromRevision) {
      return {
        kind: "ABSENT",
        evidence: `action ${context.actionId} attempt ${context.attempt} is recorded absent and deployment remains on ${input.fromRevision}`,
      };
    }
    return {
      kind: "UNRESOLVED",
      evidence: `action attempt is absent, but deployment is on unexpected revision ${current ?? "missing"}`,
    };
  }

  private bindAction(actionId: string, input: RollbackDeploymentInput): void {
    const existing = this.actionBindings.get(actionId);
    if (existing !== undefined && !this.sameRollback(existing, input)) {
      throw new Error(`action ${actionId} is already bound to a different rollback command`);
    }
    if (existing === undefined) this.actionBindings.set(actionId, { ...input });
  }

  private recordAttempt(
    input: RollbackDeploymentInput,
    context: ExecutionContext,
    disposition: RollbackAttemptEvidence["disposition"],
  ): void {
    let actionAttempts = this.attempts.get(context.actionId);
    if (actionAttempts === undefined) {
      actionAttempts = new Map<number, RollbackAttemptEvidence>();
      this.attempts.set(context.actionId, actionAttempts);
    }
    const existing = actionAttempts.get(context.attempt);
    if (
      existing !== undefined &&
      (!this.sameRollback(existing.input, input) || existing.disposition !== disposition)
    ) {
      throw new Error(`action ${context.actionId} attempt ${context.attempt} has conflicting evidence`);
    }
    if (existing === undefined) {
      actionAttempts.set(context.attempt, {
        input: { ...input },
        attempt: context.attempt,
        disposition,
      });
    }
  }

  private sameRollback(
    left: RollbackDeploymentInput,
    right: RollbackDeploymentInput,
  ): boolean {
    return (
      left.project === right.project &&
      left.deploymentId === right.deploymentId &&
      left.fromRevision === right.fromRevision &&
      left.toRevision === right.toRevision &&
      left.reason === right.reason
    );
  }
}

export function deploymentCapabilities(
  gateway: ScriptedDeploymentGateway,
): readonly CapabilityDefinition[] {
  return [
    {
      name: "deployment.inspect",
      version: "1.0.0",
      description: "Read the authoritative revision for a deployment",
      risk: "READ",
      validate: (input) => inspectInputSchema.parse(input),
      execute: (input) => gateway.inspect(inspectInputSchema.parse(input)),
    },
    {
      name: "deployment.rollback",
      version: "1.0.0",
      description: "Roll a deployment back to a verified earlier revision",
      risk: "WRITE_REVERSIBLE",
      validate: (input) => rollbackInputSchema.parse(input),
      execute: (input, context) => gateway.rollback(rollbackInputSchema.parse(input), context),
      reconcile: (input, context) =>
        gateway.reconcile(rollbackInputSchema.parse(input), context),
    },
  ];
}
