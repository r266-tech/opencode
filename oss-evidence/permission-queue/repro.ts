import { Effect, Stream } from "effect"
import { Llm, OpenCodeDriver } from "opencode-drive"

export default OpenCodeDriver.use(
  {
    opencode: { dev: process.env.OC_DEV ?? "." },
    config: { autoupdate: false, permissions: [{ action: "shell", resource: "*", effect: "ask" }] },
    tuiConfig: { animations: false },
    tui: { viewport: { cols: 100, rows: 30 } },
    project: { name: "permission-queue-repro", files: {} },
    keepArtifacts: true,
  },
  ({ ui, llm, opencode, artifacts }) =>
    Effect.gen(function* () {
      yield* llm.serve(() => Stream.make(Llm.text("Queue fixture ready.")))
      yield* ui.submit("Set up an isolated permission queue fixture")
      yield* ui.waitFor("Queue fixture ready.", { timeout: 60000 })
      const sessions = yield* opencode.session.list({ limit: 10 })
      const root = sessions.data.find((session) => !session.parentID)
      if (!root) throw new Error("Root session not found")
      const child = yield* opencode.session.create({
        parentID: root.id,
        title: "Permission child",
        permissions: [{ action: "shell", resource: "*", effect: "ask" }],
      })
      const first = yield* opencode.permission.create({
        sessionID: child.id,
        action: "shell",
        resources: ["echo CHILD_FIRST"],
      })
      if (first.effect !== "ask") throw new Error("Child request did not ask")
      yield* ui.waitFor("echo CHILD_FIRST", { timeout: 15000 })
      const before = yield* ui.getNode({ role: "dialog", label: "Permission required: Shell command" })
      console.log(
        "OBSERVATION",
        JSON.stringify({ stage: "child-visible", root: root.id, child: child.id, request: first, dialog: before }),
      )
      console.log("SCREENSHOT", yield* ui.screenshot("queue-child-first"))
      const second = yield* opencode.permission.create({
        sessionID: root.id,
        action: "shell",
        resources: ["echo ROOT_SECOND"],
      })
      if (second.effect !== "ask") throw new Error("Root request did not ask")
      yield* ui.waitFor("echo ROOT_SECOND", { timeout: 15000 })
      const after = yield* ui.getNode({ role: "dialog", label: "Permission required: Shell command" })
      const pending = yield* opencode.permission.request.list()
      console.log(
        "OBSERVATION",
        JSON.stringify({ stage: "root-preempts-child", request: second, dialog: after, pending }),
      )
      console.log("SCREENSHOT", yield* ui.screenshot("queue-root-preempts"))
      yield* ui.resize({ cols: 44, rows: 24 })
      yield* ui.waitFor("echo ROOT_SECOND")
      console.log("SCREENSHOT", yield* ui.screenshot("queue-root-preempts-narrow"))
      yield* ui.enter()
      yield* ui.waitFor("echo CHILD_FIRST", { timeout: 15000 })
      const remaining = yield* opencode.permission.request.list()
      const childStillPending = remaining.data.some((request) => request.id === first.id)
      const rootApproved = !remaining.data.some((request) => request.id === second.id)
      console.log("OBSERVATION", JSON.stringify({ stage: "after-enter", remaining, childStillPending, rootApproved }))
      if (!childStillPending || !rootApproved) throw new Error("Unexpected approval target")
      console.log("SCREENSHOT", yield* ui.screenshot("queue-child-remains-after-enter"))
      yield* opencode.permission.reply({ sessionID: child.id, requestID: first.id, decision: "reject" })
      yield* ui.waitFor("Queue fixture ready.")
      const controlFirst = yield* opencode.permission.create({
        sessionID: root.id,
        action: "shell",
        resources: ["echo SAME_SESSION_FIRST"],
      })
      yield* ui.waitFor("echo SAME_SESSION_FIRST")
      const controlSecond = yield* opencode.permission.create({
        sessionID: root.id,
        action: "shell",
        resources: ["echo SAME_SESSION_SECOND"],
      })
      const controlPending = yield* opencode.permission.request.list()
      const controlDialog = yield* ui.getNode({ role: "dialog", label: "Permission required: Shell command" })
      if (controlDialog.instance !== controlFirst.id) throw new Error("Same-session control preempted")
      console.log(
        "OBSERVATION",
        JSON.stringify({
          stage: "same-session-does-not-preempt",
          first: controlFirst,
          second: controlSecond,
          dialog: controlDialog,
          pending: controlPending,
        }),
      )
      yield* ui.enter()
      yield* ui.waitFor("echo SAME_SESSION_SECOND")
      const controlRemaining = yield* opencode.permission.request.list()
      if (controlRemaining.data.some((request) => request.id === controlFirst.id))
        throw new Error("First control request not approved")
      if (!controlRemaining.data.some((request) => request.id === controlSecond.id))
        throw new Error("Second control request not pending")
      console.log(
        "OBSERVATION",
        JSON.stringify({ stage: "same-session-enter-approves-first", remaining: controlRemaining }),
      )
      yield* opencode.permission.reply({ sessionID: root.id, requestID: controlSecond.id, decision: "reject" })
      console.log("ARTIFACTS", artifacts)
      yield* ui.press("c", { ctrl: true })
    }),
)
