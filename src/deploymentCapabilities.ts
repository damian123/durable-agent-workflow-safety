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

function deploymentKey(project: string, deploymentId: string): string {
  return `${project}/${deploymentId}`;
}

export class ScriptedDeploymentGateway {
  private readonly revisions = new Map<string, string>();
  private readonly modes = new Map<string, RollbackMode>();
  private readonly executions = new Map<string, number>();

  seed(project: string, deploymentId: string, revision: string): void {
    this.revisions.set(deploymentKey(project, deploymentId), revision);
  }

  setMode(actionId: string, mode: RollbackMode): void {
    this.modes.set(actionId, mode);
  }

  executionCount(actionId: string): number {
    return this.executions.get(actionId) ?? 0;
  }

  currentRevision(project: string, deploymentId: string): string | undefined {
    return this.revisions.get(deploymentKey(project, deploymentId));
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
    this.executions.set(context.actionId, this.executionCount(context.actionId) + 1);
    const current = this.currentRevision(input.project, input.deploymentId);
    if (current === input.toRevision) {
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
      return {
        kind: "OUTCOME_UNKNOWN",
        reason: "connection closed before the control plane acknowledged the command",
      };
    }

    this.seed(input.project, input.deploymentId, input.toRevision);
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

  async reconcile(input: RollbackDeploymentInput): Promise<ReconciliationOutcome> {
    const current = this.currentRevision(input.project, input.deploymentId);
    if (current === input.toRevision) {
      return {
        kind: "CONFIRMED",
        output: { ...input, revision: current, reconciled: true },
      };
    }
    if (current === input.fromRevision) {
      return {
        kind: "ABSENT",
        evidence: `deployment remains on ${input.fromRevision}`,
      };
    }
    return {
      kind: "UNRESOLVED",
      evidence: `deployment is on unexpected revision ${current ?? "missing"}`,
    };
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
      reconcile: (input) => gateway.reconcile(rollbackInputSchema.parse(input)),
    },
  ];
}
