import { beforeEach, describe, expect, it } from "vitest";
import { DurableActionCoordinator } from "../src/coordinator.js";
import {
  deploymentCapabilities,
  ScriptedDeploymentGateway,
} from "../src/deploymentCapabilities.js";
import { InMemoryDurableStore } from "../src/store.js";
import type { Clock } from "../src/types.js";

class TestClock implements Clock {
  constructor(private timeMs = 1_000) {}

  now(): number {
    return this.timeMs;
  }

  advance(milliseconds: number): void {
    this.timeMs += milliseconds;
  }
}

const rollbackInput = {
  project: "payments",
  deploymentId: "production",
  fromRevision: "revision-broken",
  toRevision: "revision-stable",
  reason: "production error rate increased after deployment",
};

function setup(store = new InMemoryDurableStore()) {
  const clock = new TestClock();
  const gateway = new ScriptedDeploymentGateway();
  gateway.seed("payments", "production", "revision-broken");
  const coordinator = new DurableActionCoordinator(store, clock, {
    approvalTtlMs: 500,
  });
  for (const capability of deploymentCapabilities(gateway)) {
    coordinator.register(capability);
  }
  return { clock, coordinator, gateway, store };
}

function requestRollback(coordinator: DurableActionCoordinator, actionId = "rollback-1") {
  return coordinator.requestAction({
    actionId,
    taskId: "incident-42",
    requestedBy: "on-call-engineer",
    capabilityName: "deployment.rollback",
    input: rollbackInput,
  }).action;
}

describe("DurableActionCoordinator", () => {
  it("validates strict capability input before recording an action", () => {
    const { coordinator } = setup();
    expect(() =>
      coordinator.requestAction({
        actionId: "unsafe-1",
        taskId: "incident-42",
        requestedBy: "on-call-engineer",
        capabilityName: "deployment.rollback",
        input: { ...rollbackInput, skipApproval: true },
      }),
    ).toThrow();
    expect(coordinator.events()).toHaveLength(0);
  });

  it("runs a read capability without approval", async () => {
    const { coordinator } = setup();
    const action = coordinator.requestAction({
      actionId: "inspect-1",
      taskId: "incident-42",
      requestedBy: "on-call-engineer",
      capabilityName: "deployment.inspect",
      input: { project: "payments", deploymentId: "production" },
    }).action;
    expect(action.status).toBe("READY");
    await expect(coordinator.execute(action.actionId)).resolves.toMatchObject({
      status: "SUCCEEDED",
      output: { revision: "revision-broken" },
    });
  });

  it("blocks an unapproved write and self-approval", async () => {
    const { coordinator } = setup();
    const action = requestRollback(coordinator);
    await expect(coordinator.execute(action.actionId)).rejects.toThrow(
      "AWAITING_APPROVAL",
    );
    expect(() =>
      coordinator.approveAction(
        action.actionId,
        "on-call-engineer",
        action.inputHash,
      ),
    ).toThrow("cannot approve their own");
  });

  it("binds approval to the immutable capability payload", () => {
    const { coordinator } = setup();
    const action = requestRollback(coordinator);
    expect(() =>
      coordinator.approveAction(action.actionId, "incident-commander", "wrong-hash"),
    ).toThrow("does not match");
    expect(
      coordinator.approveAction(
        action.actionId,
        "incident-commander",
        action.inputHash,
      ),
    ).toMatchObject({ status: "READY" });
  });

  it("deduplicates an identical request and rejects changed reuse", () => {
    const { coordinator } = setup();
    const first = requestRollback(coordinator);
    expect(requestRollback(coordinator)).toEqual(first);
    expect(() =>
      coordinator.requestAction({
        actionId: first.actionId,
        taskId: "incident-42",
        requestedBy: "on-call-engineer",
        capabilityName: "deployment.rollback",
        input: { ...rollbackInput, toRevision: "revision-other" },
      }),
    ).toThrow("different request");
  });

  it("executes an approved rollback once and records progress", async () => {
    const { coordinator, gateway } = setup();
    const action = requestRollback(coordinator);
    coordinator.approveAction(action.actionId, "incident-commander", action.inputHash);
    await expect(coordinator.execute(action.actionId)).resolves.toMatchObject({
      status: "SUCCEEDED",
      attemptCount: 1,
      output: { revision: "revision-stable" },
    });
    expect(gateway.executionCount(action.actionId)).toBe(1);
    expect(coordinator.events(action.actionId).map((event) => event.type)).toEqual([
      "ACTION_REQUESTED",
      "APPROVAL_REQUIRED",
      "APPROVED",
      "EXECUTION_STARTED",
      "SUCCEEDED",
    ]);
  });

  it("reconciles an unknown but applied outcome without executing twice", async () => {
    const { coordinator, gateway } = setup();
    const action = requestRollback(coordinator);
    coordinator.approveAction(action.actionId, "incident-commander", action.inputHash);
    gateway.setMode(action.actionId, "UNKNOWN_APPLIED");
    expect(await coordinator.execute(action.actionId)).toMatchObject({
      status: "OUTCOME_UNKNOWN",
    });
    expect(await coordinator.reconcile(action.actionId)).toMatchObject({
      status: "SUCCEEDED",
      output: { reconciled: true },
    });
    expect(gateway.executionCount(action.actionId)).toBe(1);
  });

  it("retries only after reconciliation proves the first action absent", async () => {
    const { coordinator, gateway } = setup();
    const action = requestRollback(coordinator);
    coordinator.approveAction(action.actionId, "incident-commander", action.inputHash);
    gateway.setMode(action.actionId, "UNKNOWN_ABSENT");
    await coordinator.execute(action.actionId);
    await expect(coordinator.execute(action.actionId)).rejects.toThrow("OUTCOME_UNKNOWN");
    expect(await coordinator.reconcile(action.actionId)).toMatchObject({ status: "READY" });
    gateway.setMode(action.actionId, "SUCCEED");
    await expect(coordinator.execute(action.actionId)).resolves.toMatchObject({
      status: "SUCCEEDED",
      attemptCount: 2,
    });
    expect(gateway.executionCount(action.actionId)).toBe(2);
  });

  it("keeps an unexpected external revision unresolved", async () => {
    const { coordinator, gateway } = setup();
    const action = requestRollback(coordinator);
    coordinator.approveAction(action.actionId, "incident-commander", action.inputHash);
    gateway.setMode(action.actionId, "UNKNOWN_ABSENT");
    await coordinator.execute(action.actionId);
    gateway.seed("payments", "production", "revision-third-party");
    await expect(coordinator.reconcile(action.actionId)).resolves.toMatchObject({
      status: "OUTCOME_UNKNOWN",
      failureReason: expect.stringContaining("unexpected revision"),
    });
  });

  it("restores an unknown action from a durable snapshot before reconciling", async () => {
    const { clock, coordinator, gateway, store } = setup();
    const action = requestRollback(coordinator);
    coordinator.approveAction(action.actionId, "incident-commander", action.inputHash);
    gateway.setMode(action.actionId, "UNKNOWN_APPLIED");
    await coordinator.execute(action.actionId);

    const restoredStore = new InMemoryDurableStore(store.snapshot());
    const restored = new DurableActionCoordinator(restoredStore, clock, {
      approvalTtlMs: 500,
    });
    for (const capability of deploymentCapabilities(gateway)) restored.register(capability);
    await expect(restored.reconcile(action.actionId)).resolves.toMatchObject({
      status: "SUCCEEDED",
    });
    expect(gateway.executionCount(action.actionId)).toBe(1);
  });

  it("expires approval before a write can execute", async () => {
    const { clock, coordinator } = setup();
    const action = requestRollback(coordinator);
    coordinator.approveAction(action.actionId, "incident-commander", action.inputHash);
    clock.advance(501);
    await expect(coordinator.execute(action.actionId)).rejects.toThrow("approval expired");
    expect(coordinator.getAction(action.actionId).status).toBe("AWAITING_APPROVAL");
  });

  it("allows cancellation only before execution starts", async () => {
    const { coordinator } = setup();
    const pending = requestRollback(coordinator, "rollback-cancelled");
    expect(() => coordinator.cancel(pending.actionId, "unrelated-user")).toThrow(
      "not authorized",
    );
    expect(coordinator.cancel(pending.actionId, "on-call-engineer")).toMatchObject({
      status: "CANCELLED",
    });
    const completed = requestRollback(coordinator, "rollback-completed");
    coordinator.approveAction(completed.actionId, "incident-commander", completed.inputHash);
    await coordinator.execute(completed.actionId);
    expect(() => coordinator.cancel(completed.actionId, "incident-commander")).toThrow(
      "SUCCEEDED",
    );
  });
});
