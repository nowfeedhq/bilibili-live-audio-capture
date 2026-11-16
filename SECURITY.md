# Security

Deploy behind HTTPS with a dedicated random token and a nonprivileged account.
The service is not multi-tenant: one token permits all sessions. Never share it
with untrusted clients. Browser extensions and local administrator access are part
of your trust boundary. Data directories must not be writable by other users.
Session IDs are validated, filenames are server-selected, and user room titles
never become paths. Symlinked session directories are rejected; trusted local
ownership remains necessary for all spool subdirectories.

Request bodies, sequence counts, per-session size, total spool usage and free space
are bounded. Single-process locking prevents competing writers. Slow clients can
still consume connections; use proxy timeouts and access controls for an exposed
server. This is a personal capture service, not an untrusted public upload service.
Interrupted sessions are sealed incomplete at restart. Atomic renames and fsync
protect individual writes, but do not substitute for backups or filesystem health.

The source package contains no credentials or actual recordings. The generated
config, logs and recording data must stay excluded from version control. Review
all files and Git author/committer metadata before publication. GitHub account
activity can identify the publishing account even when commit display names differ.
Do not create a public issue containing a token, private room content or server logs.
