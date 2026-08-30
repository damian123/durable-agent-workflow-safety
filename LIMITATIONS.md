# Limitations

This is a framework-neutral safety core for tool authority and unknown outcomes. It is not a production agent runtime.

## Persistence

The store is a deterministic in-memory boundary with snapshot restoration. It is not a database. Restart tests restore from that snapshot; they do not prove crash-safe durability.

## Identity and policy

Approver names are strings supplied by the demo. There is no SSO, delegated credential, policy engine, or human approval channel. Separation of duties is the coordinator's own check after identity normalization.

## External effects

The deployment control plane is scripted. A production adapter must implement the target system's real idempotency and reconciliation semantics. This repository only shows the states those adapters would have to report.

## Not included

No real deployment, account, credential, model, prompt, customer, or employer system. Incident and deployment data are fixtures.

## Production gaps

Transactional persistence and outbox delivery, concurrency fencing, worker leases, authenticated delegated identity, policy integration, encryption and redaction, secret isolation, real approval channels, version migration, OpenTelemetry, backpressure, and rate limiting.
