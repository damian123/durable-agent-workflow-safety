# Standalone publication checklist

Use this checklist before presenting or republishing the repository as portfolio evidence.

## Provenance and scope

- Confirm `EVIDENCE.json` names the artifact owner and repository account.
- Keep the synthetic-data and non-production boundaries in `README.md`.
- Do not add employer, customer, production, credential, incident, or deployment data.
- Review the complete Git history, not only the current working tree, for secrets and private information.

## Verification

Run from a clean clone:

```bash
npm ci
npm run verify
./scripts/build-evidence-manifest.sh
git diff --exit-code -- MANIFEST.sha256
```

Expected result: strict TypeScript checking passes, seventeen tests pass, the structured walkthrough completes, and regenerating the evidence manifest produces no diff.

## Claims

- Describe the project as a deterministic safety-core demonstration, not a production agent framework.
- Do not claim that the in-memory snapshot store supplies transactional durability.
- Do not claim operational scale, availability, security certification, or employer provenance.
- Treat approval, identity, reconciliation, observability, and external-system behavior as integration boundaries requiring production implementations.
