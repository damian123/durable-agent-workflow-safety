import { DurableActionCoordinator } from "./coordinator.js";
import {
  deploymentCapabilities,
  ScriptedDeploymentGateway,
} from "./deploymentCapabilities.js";
import { InMemoryDurableStore } from "./store.js";
import type { Clock } from "./types.js";

class DemoClock implements Clock {
  constructor(private timeMs: number) {}

  now(): number {
    return this.timeMs;
  }

  advance(milliseconds: number): void {
    this.timeMs += milliseconds;
  }
}

function buildCoordinator(
  store: InMemoryDurableStore,
  gateway: ScriptedDeploymentGateway,
  clock: Clock,
): DurableActionCoordinator {
  const coordinator = new DurableActionCoordinator(store, clock);
  for (const capability of deploymentCapabilities(gateway)) {
    coordinator.register(capability);
  }
  return coordinator;
}

const clock = new DemoClock(1_000);
const gateway = new ScriptedDeploymentGateway();
gateway.seed("payments", "production", "revision-broken");

const firstStore = new InMemoryDurableStore();
const firstCoordinator = buildCoordinator(firstStore, gateway, clock);

const inspection = firstCoordinator.requestAction({
  actionId: "inspect-production-1",
  taskId: "incident-42",
  requestedBy: "on-call-engineer",
  capabilityName: "deployment.inspect",
  input: { project: "payments", deploymentId: "production" },
});
await firstCoordinator.execute(inspection.action.actionId);

const rollback = firstCoordinator.requestAction({
  actionId: "rollback-production-1",
  taskId: "incident-42",
  requestedBy: "on-call-engineer",
  capabilityName: "deployment.rollback",
  input: {
    project: "payments",
    deploymentId: "production",
    fromRevision: "revision-broken",
    toRevision: "revision-stable",
    reason: "error rate increased after the latest deployment",
  },
});

let unapprovedWriteBlocked = false;
try {
  await firstCoordinator.execute(rollback.action.actionId);
} catch {
  unapprovedWriteBlocked = true;
}

firstCoordinator.approveAction(
  rollback.action.actionId,
  "incident-commander",
  rollback.action.inputHash,
);
gateway.setMode(rollback.action.actionId, "UNKNOWN_APPLIED");
await firstCoordinator.execute(rollback.action.actionId);

clock.advance(250);
const restoredStore = new InMemoryDurableStore(firstStore.snapshot());
const restoredCoordinator = buildCoordinator(restoredStore, gateway, clock);
const reconciled = await restoredCoordinator.reconcile(rollback.action.actionId);

console.log(
  JSON.stringify(
    {
      unapprovedWriteBlocked,
      processRestartedFromSnapshot: true,
      externalExecutionCount: gateway.executionCount(rollback.action.actionId),
      finalAction: reconciled,
      progress: restoredCoordinator.events(rollback.action.actionId),
    },
    null,
    2,
  ),
);
