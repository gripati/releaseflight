# Runbook: RLS violation spike

## Symptom

`gp_rls_violations_total` is non-zero or rising. Postgres logs show
`new row violates row-level security policy` errors.

## Impact

POTENTIALLY SEV1 — a non-zero rate is either a code bug allowing a
cross-tenant access attempt **OR** an active attacker. Treat as both
until you've ruled out the first.

## Diagnosis

```sql
-- Last violation events (Postgres logs)
-- Configure log_min_messages='warning' so policy denials log.

-- Look at audit events around the same time
SELECT *
FROM "AuditEvent"
WHERE "createdAt" > now() - interval '30 minutes'
  AND ("action" LIKE 'app.%' OR "action" LIKE 'metadata.%')
ORDER BY "createdAt" DESC;
```

```bash
# Inspect web logs for the offending request id
grep "<requestId>" /var/log/gp/*.log
```

## Resolution

### Genuine attacker probe

1. Identify the user / IP from the audit row.
2. Disable the user: `UPDATE "User" SET status = 'DISABLED' WHERE id = …`
3. Revoke all sessions: `DELETE FROM "Session" WHERE userId = …`
4. Notify the tenant OWNER via email.
5. File a security incident: `docs/incidents/<date>-rls-probe.md`.

### Code bug

1. Find the route handler emitting the failing query.
2. Verify it wraps the body in `withTenantContext`.
3. Add a regression test in `packages/db/src/__tests__/rls.test.ts`.
4. Roll forward a fix and verify the violation rate returns to zero.

## Post-incident

- Engineering review for the entire RLS test suite
- Confirm no rows were exposed (DB audit log + S3 access log)
