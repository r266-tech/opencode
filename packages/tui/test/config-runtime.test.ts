import { expect, test } from "bun:test"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"

const entries = [
  path.join(import.meta.dir, "../src/config/index.tsx"),
  path.join(import.meta.dir, "../src/config/v1/index.tsx"),
]

test.each(entries)("loads the Solid config runtime outside the package directory: %s", async (entry) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "opencode-config-runtime-"))
  const home = path.join(root, "home")
  await fs.mkdir(home)

  try {
    const child = Bun.spawn([process.execPath, "--eval", `await import(${JSON.stringify(entry)})`], {
      cwd: root,
      env: {
        HOME: home,
        PATH: process.env.PATH ?? "",
        TEMP: root,
        TMP: root,
        TMPDIR: root,
        USERPROFILE: home,
        ...(process.env.SystemRoot ? { SystemRoot: process.env.SystemRoot } : {}),
      },
      stdout: "pipe",
      stderr: "pipe",
    })
    const [exitCode, stdout, stderr] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ])

    expect({ exitCode, stdout, stderr }).toEqual({ exitCode: 0, stdout: "", stderr: "" })
  } finally {
    await fs.rm(root, { recursive: true, force: true })
  }
})
