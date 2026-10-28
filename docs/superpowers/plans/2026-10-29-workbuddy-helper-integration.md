# WorkBuddy Helper in Stream

**Goal:** Manage WorkBuddy Helper accounts, sign-in results, and one daily schedule from Stream.

**Ownership:** Helper remains the sole owner of account tokens and upstream WorkBuddy calls. A Stream integration client owns the Helper HTTP protocol. Stream's task center owns scheduling and run history; a native management tab consumes the same client through Stream routes. Magpie remains independent.

## Steps

1. Add a small Helper HTTP client with tests for session-token refresh, account state, and partial batch failure. Only allow a loopback Helper URL.
2. Expose narrow Stream routes for state, login, single/batch check-in, and schedule control. Never relay account tokens or Helper's raw page token to the browser.
3. Register a user-schedulable `workbuddy:checkin` action backed by the same client. The action rejects partial failure and reports per-account status without secrets.
4. Add a WorkBuddy management tab for adding accounts via official authorization, viewing balances and check-in status, manual actions, and setting the Stream schedule. Disable Helper's own daily schedule during connection.
5. Update current architecture/API instructions, run focused tests, typechecks, build, and inspect a real response if a Helper instance is available.

**Limits:** Without authorized WorkBuddy accounts, local tests can verify the integration contract but cannot prove actual points were awarded.
