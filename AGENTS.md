# AGENTS.md

Rules for working in this repository. They constrain how changes are delivered, not what the registry does.

## Never push or deploy an unverified fix

Do not push a commit that changes runtime behaviour, and do not let a push trigger a deployment, until the fix is confirmed to solve the reported problem end to end.

A pushed commit on `main` deploys the worker and publishes the registry, so a push is a production change, not a backup of work in progress. A change that compiles and passes the test suite is not verified: the suite covers the worker's own logic, and the reported failure lives in how a client resolves packages against the deployed registry, which only a real install against the live domain exercises.

Before pushing a behavioural change:

1. Reproduce the reported failure and record what it looks like.
2. Apply the fix and reproduce the same scenario again, provisioning the same way the user's client does. A test in the suite is necessary but is not the reproduction.
3. Confirm the reproduction now succeeds, and that what should still be refused still is.
4. Only then push.

When a fix is uncertain, or a reproduction has not been run against the deployed worker, say so plainly and keep the work local. A wrong deployment is worse than a slow one: it changes what every client resolves, and the free KV quota makes a rollback neither instant nor free.

Fixes to documentation, comments, and tests alone may be pushed without a live reproduction, because they change nothing a client sees.
