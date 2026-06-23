# Runbook: Google integration failing

## Symptom

`gp_upstream_requests_total{provider="google"}` spike. Edits fail to
commit. The smart-commit pipeline returns "auto_review unavailable"
or similar.

## Impact

SEV2 — Android push + AAB upload + track promotion blocked.

## Diagnosis

```bash
# Google Cloud status: https://status.cloud.google.com/
# Apple keys are not affected.

# Reproduce
curl -s -H "Authorization: Bearer <token>" \
  https://androidpublisher.googleapis.com/androidpublisher/v3/applications/<pkg>/edits

# Pattern recognition:
# - "Edit already exists" — orphan from previous commit; delete it
# - "Only releases with status draft" — smart commit handles this; verify the
#   draft_autosave fallback fires in worker logs
# - "Quota exceeded" — Google quotas reset at midnight Pacific
```

## Resolution

### Orphan edit

```bash
# List edits
curl -s -H "Authorization: Bearer <token>" \
  "https://androidpublisher.googleapis.com/androidpublisher/v3/applications/<pkg>/edits"

# Delete each:
curl -X DELETE -H "Authorization: Bearer <token>" \
  "https://androidpublisher.googleapis.com/androidpublisher/v3/applications/<pkg>/edits/<editId>"
```

### Quota exceeded

- Wait for the daily reset (midnight PST)
- Or request a quota bump from the Google Play Console

## Post-incident

- Verify the worker correctly mapped the "draft_autosave" outcome to
  SUCCESS in the audit log
- Add a regression integration test for the failed pattern
