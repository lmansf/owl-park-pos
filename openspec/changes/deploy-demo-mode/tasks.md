# Tasks — deploy-demo-mode

Retro-spec: the code shipped in `960affb` and `06ef9eb`; these tasks only reconcile specs.

## Phase A — spec reconciliation (serial)

- [x] A1 MODIFIED session-auth requirement (stateless HMAC tokens, OWLPOS_SECRET,
      sessions table retained-but-unused)
- [x] A2 ADDED requirements: serverless entry + ephemeral demo mode, /api/health
      self-description, in-app Help page
- [ ] A3 Verify scenarios against code (api/index.js, server/core/auth.js,
      server/main.js /api/health, web/help.html), then archive this change
