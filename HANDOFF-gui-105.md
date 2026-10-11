# GUI #105 review fixes

Measured toolchain data remains the single evidence block. Git is sampled at
start, end and full scans. Ordinary watched edits defer status/log/diff only
after a known Git sample with unchanged commit and branch; commit-only and
branch-only changes still capture. Deferred envelopes use
\`git_deferred: "session_end"\` and \`dirty: null\`; non-Git and disabled
Git roots are never marked deferred.

Verification: \`bun test apps/server/src/session-uploader.test.ts\` — 140
passed, 0 failed, 1,973 assertions. \`git diff --check\` passed. Not
deployed or released.
