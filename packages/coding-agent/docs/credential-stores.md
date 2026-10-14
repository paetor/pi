# Session-owned logout

An application-owned store routed with `ModelRuntime.setCredentialStore()` may expose
`logoutSession(providerId: string, options: AuthOperationOptions): Promise<void>`.
`ModelRuntime.logout()` delegates to it instead of deleting credentials. Ordinary
stores retain the existing delete-and-synchronize behavior.

The handler owns the session's idle boundary, persistence, replacement route, and
local status. It runs outside the credential mutation queue so it can await
`setCredentialStore()` without deadlocking. A failed handler never falls through
to deletion. An already-aborted operation never invokes it.

A session-only logout must not delete a shared credential family. Install a
fail-closed route rather than removing the route and exposing default credentials.
Persist the logged-out selection before reporting success and roll back the route
if persistence fails. Requests/children captured before logout keep their original
store. Global credential deletion must be a separately confirmed application action.
