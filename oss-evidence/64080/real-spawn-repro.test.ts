import { expect } from "bun:test"
import { writeFile } from "node:fs/promises"
import path from "node:path"
import { Effect } from "effect"
import { makeDaemonTransport } from "../src/persistent-pty/daemon"
import { temporaryDirectory } from "./fixture/persistent-pty-daemon"
import { it } from "./lib/effect"

// Local diagnostic only: two real 5-second readiness polls, and forty seconds on the unmodified base.
it.live(
  "counts real helper spawns when registration advertises a missing socket",
  () =>
    Effect.gen(function* () {
      const root = yield* temporaryDirectory()
      const binary = path.join(root, "fake-pty")
      yield* Effect.promise(() =>
        writeFile(
          binary,
          [
            "#!/bin/sh",
            'echo spawn >> "$3/spawns"',
            'directory="$3/$5"',
            'mkdir -p "$directory"',
            `printf '{"instance_id":"unreachable","pid":%s,"protocol":8,"socket":"%s/missing.sock","token":"t","features":[]}' $$ "$directory" > "$directory/service.json"`,
            "exec sleep 30",
          ].join("\n"),
          { mode: 0o755 },
        ),
      )
      const daemon = yield* makeDaemonTransport(root, "daemon", () => Promise.resolve(binary))
      const results: object[] = []
      for (const call of [1, 2]) {
        const start = performance.now()
        const error = yield* daemon.request({ op: "list", mode: "pipe" }, true).pipe(Effect.flip)
        const spawns = (yield* Effect.promise(() => Bun.file(path.join(root, "spawns")).text())).trim().split("\n").length
        results.push({ call, kind: error.kind, ms: Math.round(performance.now() - start), spawns })
      }
      console.log(JSON.stringify(results))
      expect((yield* Effect.promise(() => Bun.file(path.join(root, "spawns")).text())).trim().split("\n")).toHaveLength(2)
    }),
  // This diagnostic measures the existing readiness timeout without adding a production timing seam.
  60_000,
)
