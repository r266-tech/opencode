# OpenCode #64080: PTY start failure backoff

Candidate: [pty-start-backoff](https://github.com/r266-tech/opencode/commit/1def5d67493f0216e00c760b5ed82f5b9b06958e) on `dev d432a06b9c`.

A failed startup is shared for 30 seconds rather than repeated by every request. Discovery still runs, so a daemon that becomes reachable during that delay is usable immediately. A successful ownership claim clears the failure. The retry uses Effect's monotonic clock; no public API or startup timing seam is added.

## Reproduction

The diagnostic below calls the real `makeDaemonTransport`. Its helper writes a valid registration and stays alive without creating the advertised socket. It does not run the CLI, a shell tool call, a model or a provider. The probe creates its own temporary directory, and production startup failure handling terminates each helper.

| Build | Request 1 | Request 2 | Total helper spawns |
| --- | --- | --- | --- |
| Unmodified dev | 20174 ms | 20056 ms | 8 |
| Candidate | 10038 ms | 3 ms | 2 |

Observed once on macOS arm64, Bun 1.4.4. These are local diagnostic timings, not a general performance guarantee. The diagnostic's assertion is the helper-spawn count, not elapsed time.

Copy `real-spawn-repro.test.ts` into `packages/core/test/persistent-pty-backoff-repro.test.ts` and run from `packages/core`:

```sh
bun run script/test.ts test/persistent-pty-backoff-repro.test.ts
```

It takes about 40 seconds and fails on unmodified dev (8 spawns where 2 are expected), and takes about 10 seconds and passes on the candidate (2 spawns). This slow diagnostic is an evidence artifact, excluded from the candidate's CI tests.

## Checks

```sh
cd packages/core
bun run script/test.ts test/persistent-pty-daemon.test.ts --rerun-each 10 --randomize
bun run script/test.ts test/persistent-pty-daemon.test.ts test/persistent-pty-session.test.ts test/shell-daemon.test.ts test/shell-restart.test.ts test/shell.test.ts test/pty
bun run typecheck:tsc
cd ../..
bun run check
```

The new committed regression fails on the base: one failed resolution followed by four concurrent requests makes five startup attempts. The candidate makes one, allows a retry at the 30-second boundary on a controlled monotonic clock, and discovers a real recovered socket before the next boundary.

Local results: 120 randomized daemon-test passes; 66 related PTY, session, shell and restart passes / 2 skips; root lint/all 35 typechecks and Core official TypeScript pass. #61750 is a separate ownership/registration consistency fix and does not add startup backoff.

The original sandbox's AF_UNIX permission denial, the reported idle retry loop, Windows and Linux were not reproduced. This patch does not change the sandbox policy or permanently disable the daemon. AI-assisted implementation and verification.
