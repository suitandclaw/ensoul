# Security: @ensoul/explorer

## Threat Model
Read-only API against node state. No write operations. Input validation on all path/query parameters.

## Invariants
1. All API endpoints MUST return valid JSON with correct content types.
2. Agent lookup MUST return 404 for unknown DIDs, not leak data.
3. Block lookup MUST validate height parameter as a number.
4. Verify endpoint MUST compute trust assessment deterministically.
