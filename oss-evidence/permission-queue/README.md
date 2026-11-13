# TUI permission request preemption

Source: `anomalyco/opencode` dev `f91b88efac039856f284979984ac43cd93bce8f5`.
Environment: macOS arm64, Bun 1.4.4, opencode-drive 2.4.1 with its Effect 4.0.1 peer.

The real source CLI/TUI and private source server are used. A deterministic local responder only creates an initial root session; no model service is contacted. Subsequent sessions and permission requests are created through the public API. The `echo` strings are permission resources, not executed shell commands. No rewrite plugin is installed.

Run with a checkout of that source, with its frozen dependencies installed:

```sh
mkdir -p /tmp/opencode-permission-queue
cd /tmp/opencode-permission-queue
bun add opencode-drive@2.4.1 effect@4.0.1
OC_DEV=/absolute/path/to/opencode bunx opencode-drive run /absolute/path/to/repro.ts
```

Observed sequence:

1. Child request A (`echo CHILD_FIRST`) is visible.
2. Root request B (`echo ROOT_SECOND`) arrives. The API still lists A and B, but the real TUI dialog's semantic `instance` changes from A's permission ID to B's without answering A.
3. Enter removes B; A remains pending and becomes visible again.
4. A control with two requests in the same root session preserves the first dialog. Enter approves that first request, leaving the second.

`observations.json` contains the IDs and public API readbacks. The fixture's temporary directory is redacted. PNGs capture the real source TUI at 100x30 and 44x24. `repro.ts` is the complete driver script.

This isolates request selection by session-tree priority. It does not reproduce a provider issuing tool calls, a live user's parallel-worker setup, or an authorization bypass. #63774/#63835 address stale input displayed for a single request, a separate path.
