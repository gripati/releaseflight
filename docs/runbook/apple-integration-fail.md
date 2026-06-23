# Runbook: Apple integration failing

## Symptom

`gp_upstream_requests_total{provider="apple", status_class="5xx"}` spikes.
Metadata pull/push jobs fail. Login fine; only Apple-specific actions
broken.

## Impact

SEV2 — Apple-related features unusable; Google still works.

## Diagnosis

```bash
# Apple system status: https://developer.apple.com/system-status/
# Reproduce locally with a sandbox credential:
curl -s -H "Authorization: Bearer $(node scripts/mint-test-jwt.mjs)" \
  https://api.appstoreconnect.apple.com/v1/apps?limit=1

# Common upstream issues:
# - 401: key rotated, .p8 doesn't match the keyId/issuerId anymore
# - 403: API key revoked
# - 5xx: Apple-side outage (announced on the system-status page)
```

## Resolution

- **401 / 403** — tell the user to rotate the credential. Mark
  `Credential.lastTestSucceeded = false` so the UI banner shows up.
- **5xx upstream** — activate the maintenance banner pointing at
  Apple's status page. Pause the BullMQ `metadata.fetch` and
  `metadata.push` queues (`bull-board` → pause).
- **JWT signature failure** — only happens when the `.p8` is mangled.
  Re-upload from the credentials page.

## Post-incident

- Confirm the credential's `lastTestSucceeded` is updated.
- Add a synthetic check (`POST /credentials/<id>/test` every 30 min)
  for production credentials.
