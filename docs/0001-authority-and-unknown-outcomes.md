# ADR 0001: keep authority and uncertain effects outside model discretion

## Status

Accepted for this demonstration.

## Context

An internal agent may propose actions that read or change production systems. A model-generated plan is not proof that the requester is authorized, and a transport timeout after a write is not proof that the write failed. Treating either as true can create unauthorized or duplicate effects.

## Decision

- Capability risk and approval requirements are deterministic code and cannot be overridden through capability input.
- Every write is runtime-validated, fingerprinted, and persisted before execution.
- Approval is given by a different identity, bound to the immutable input fingerprint, and time-limited.
- The stable action ID is passed to the external adapter as an idempotency and correlation key.
- Once execution begins, an adapter exception is conservatively recorded as an unknown outcome.
- An unknown outcome blocks another execution until authoritative external reconciliation confirms the effect, proves it absent, or leaves it unresolved.
- Progress events make approval, execution, uncertainty, and reconciliation visible outside the conversational transcript.

## Consequences

The workflow has more states than a simple tool loop, but recovery behavior is explicit and testable. A production implementation must make the action transition and outbox write transactional, use a durable database and worker lease, enforce real identity and policy, protect secrets, and integrate an external system's actual idempotency and reconciliation semantics.
