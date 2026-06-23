# Runbook: Credential leak suspected

## Symptom

`gitleaks` finding, an Apple `.p8` file shows up in a public gist,
suspicious activity in App Store Connect / Google Play Console, or a
worker log contains the literal `BEGIN PRIVATE KEY`.

## Impact

POTENTIAL SEV1 — an attacker can push hostile builds, change app
metadata, or remove apps from the store.

## Diagnosis

```bash
# Confirm the leak is real
grep -rn "BEGIN PRIVATE KEY" /var/log/gp/*.log     # last 7 days
grep -rn "private_key" /var/log/gp/*.log

# Identify which credential leaked (file path / key id / issuer id)
grep -A2 "kid\":" /var/log/gp/*.log
```

## Resolution (do these in parallel)

1. **Contain** — disable the credential in the app:
   ```sql
   UPDATE "Credential" SET "isActive" = false WHERE id = '<id>';
   ```
   This stops any further upstream calls.

2. **Rotate at the upstream** —
   - Apple: log into App Store Connect → Users and Access → Keys →
     revoke the leaked key, generate a new one.
   - Google: revoke the leaked service-account JSON key in IAM,
     generate a new one.

3. **Upload the new credential** via the UI; the secret-ref in
   `Credential.secretRef` will point at a brand-new file/secret.

4. **Audit** — query for everything done with the leaked credential:
   ```sql
   SELECT * FROM "AuditEvent"
   WHERE diff::text LIKE '%<credentialId>%'
     AND "createdAt" > '<rotation-timestamp - 7d>';
   ```
   Cross-reference with App Store Connect / Google Play Console
   activity log to spot anything the attacker did.

5. **Notify** the tenant OWNER and (if SaaS) Apple/Google security teams.

## Post-incident

- File an incident report.
- Run `grep -rn "BEGIN PRIVATE KEY" .` against the entire codebase to
  make sure the pattern isn't reproducible.
- Add the leak pattern to the `LogRedactor` test suite.
- Rotate the project's `STORAGE_SIGNING_SECRET` and `SESSION_SECRET`
  as a precaution.
