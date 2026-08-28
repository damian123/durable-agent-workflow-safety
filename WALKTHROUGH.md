# Two-minute walkthrough

Use this script for a recruiter screen, technical introduction, or recorded portfolio explanation. Keep the code open at `src/coordinator.ts` and the terminal ready for `npm run verify`.

## 0:00-0:20 — the problem

> This is a synthetic TypeScript safety core for an internal agent that can inspect and roll back a production deployment. The important problem is not generating a plan. It is ensuring that a model cannot bypass authority and that a lost acknowledgement cannot cause a duplicate production action.

Show: the architecture diagram in `README.md`.

## 0:20-0:45 — typed capabilities and deterministic policy

> Each capability has a version, runtime-validated input, and declared risk. A read can proceed immediately. A write enters `AWAITING_APPROVAL`. Approval policy is deterministic TypeScript below the model layer, so adding something like `skipApproval` to generated input fails schema validation.

Show: `deploymentCapabilities.ts`, then `requestAction` in `coordinator.ts`.

## 0:45-1:10 — durable action and bound approval

> Before execution, the coordinator records a stable action ID, validated payload, capability version, and SHA-256 input fingerprint. The requester cannot approve their own write in this demonstration policy. A different approver must approve the exact fingerprint, and that approval expires. Reusing the action ID with changed input is rejected.

Show: `approveAction` and the approval-related tests.

## 1:10-1:35 — the hard failure mode

> The scripted control plane applies the rollback but closes the connection before acknowledging it. The coordinator records `OUTCOME_UNKNOWN`; it does not call the tool again. The demo then snapshots the store, creates a new coordinator to represent a process restart, and asks the authoritative control plane which revision is active.

Show: `execute`, `reconcile`, and `src/demo.ts`.

## 1:35-1:50 — verified recovery

> Reconciliation finds the target revision, so the durable action finishes as `SUCCEEDED`. The walkthrough reports one external execution despite the lost acknowledgement and process restart. A separate test proves that retry becomes possible only when reconciliation shows the first action was absent.

Show: the final terminal output and the unknown-outcome tests.

## 1:50-2:00 — honest production boundary

> This deliberately proves the state and authority semantics, not a production framework. Production would replace the in-memory store with transactional persistence and an outbox, add fenced workers and delegated identity, integrate real policy and approval systems, and emit privacy-aware OpenTelemetry traces.

## Live verification

```bash
npm ci
npm run verify
npm audit --audit-level=high
```

Expected evidence:

- strict TypeScript compilation succeeds;
- twelve acceptance tests pass;
- the walkthrough ends in `SUCCEEDED`;
- `externalExecutionCount` is `1`; and
- the dependency audit reports no vulnerabilities.

## Likely follow-ups

### Why not put approval instructions in the system prompt?

Prompts guide model behavior but do not enforce authority. A deterministic boundary must authenticate identity, evaluate policy, bind approval to an immutable action, and prevent the adapter call when policy is not satisfied.

### Why does an adapter exception become an unknown outcome?

Once execution has begun, the coordinator cannot assume that an exception means the external system rejected the action. Conservatively recording uncertainty prevents an unsafe duplicate. The adapter's reconciliation contract determines what happens next.

### Why use a supplied action ID?

It gives the workflow, adapter, external system, telemetry, and operator one stable idempotency and correlation identity. Reuse with a different request is rejected.

### What is missing for concurrent workers?

A production store needs optimistic concurrency or transactional compare-and-swap, a durable outbox, worker leases and fencing, recovery of abandoned `IN_PROGRESS` work, and target-specific idempotency guarantees.

### How would this connect to an AI SDK agent?

The model-facing tool would propose a validated capability request. The coordinator would remain the execution boundary. Agent streaming could present progress events, while a durable workflow runtime could suspend for approval and resume later. The safety state must remain authoritative outside the conversational transcript.
