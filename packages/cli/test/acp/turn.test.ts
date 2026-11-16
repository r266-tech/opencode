import { describe, expect, test } from "bun:test"
import type { SessionNotification } from "@agentclientprotocol/sdk"
import { ACPElicitation } from "../../src/acp/elicitation"
import {
  childCreated,
  delivered,
  durableEvent,
  ephemeralEvent,
  permissionAsked,
  startSession,
  succeeded,
  textDelta,
  toolCalled,
  toolStarted,
  toolSucceeded,
  turn,
} from "./wire-fixture"

const grandchild = {
  "opencode/child-session": { id: "ses_grandchild", parentID: "ses_child", depth: 2, title: "Deeper" },
}

describe("acp turn events over the wire", () => {
  test.each([
    {
      childSessionUpdates: false,
      parent: [
        {
          sessionUpdate: "tool_call",
          toolCallId: "ses_grandchild:call_read",
          title: "Deeper: read",
          _meta: grandchild,
        },
        { sessionUpdate: "tool_call_update", toolCallId: "ses_grandchild:call_read", status: "in_progress" },
        { sessionUpdate: "tool_call_update", toolCallId: "ses_grandchild:call_read", status: "completed" },
      ],
      child: [],
    },
    {
      childSessionUpdates: true,
      parent: [],
      child: [
        { childSessionId: "ses_child", depth: 1, type: "status", status: "created" },
        { childSessionId: "ses_child", type: "status", status: "running" },
        {
          childSessionId: "ses_grandchild",
          parentSessionId: "ses_child",
          depth: 2,
          title: "Deeper",
          status: "created",
        },
        {
          childSessionId: "ses_grandchild",
          update: { sessionUpdate: "tool_call", toolCallId: "ses_grandchild:call_read" },
        },
        { childSessionId: "ses_grandchild", update: { sessionUpdate: "tool_call_update", status: "in_progress" } },
        { childSessionId: "ses_grandchild", update: { sessionUpdate: "tool_call_update", status: "completed" } },
        { childSessionId: "ses_grandchild", type: "status", status: "completed" },
        { childSessionId: "ses_background", type: "status", status: "created" },
        { childSessionId: "ses_child", type: "status", status: "completed" },
        { childSessionId: "ses_background", type: "status", status: "running" },
        { childSessionId: "ses_background", type: "update", update: { sessionUpdate: "agent_message_chunk" } },
        { childSessionId: "ses_background", type: "status", status: "completed" },
      ],
    },
  ])(
    "shows nested and background child work and routes its permissions (child capability: $childSessionUpdates)",
    async (row) => {
      await using acp = await startSession({
        capabilities: { childSessionUpdates: row.childSessionUpdates },
        onPrompt: ({ sessionID, id }) =>
          acp.server.prompts.length > 1
            ? turn(sessionID, id)
            : turn(
                sessionID,
                id,
                childCreated("ses_child", sessionID, "Explore code"),
                durableEvent("session.execution.started", { sessionID: "ses_child" }),
                childCreated("ses_grandchild", "ses_child", "Deeper"),
                toolStarted("ses_grandchild", "call_read", "read"),
                toolCalled("ses_grandchild", "call_read", { path: "/workspace/src/index.ts" }),
                permissionAsked("ses_grandchild", "perm_child", {
                  action: "read",
                  source: { type: "tool", messageID: "msg_child", id: "call_read" },
                }),
                toolSucceeded("ses_grandchild", "call_read", {}, "source"),
                succeeded("ses_grandchild"),
                childCreated("ses_background", sessionID, "Research"),
                succeeded("ses_child"),
              ),
        permission: () => ({ outcome: { outcome: "selected", optionId: "once" } }),
      })

      expect((await acp.prompt(acp.sessionId, "hello")).stopReason).toBe("end_turn")
      const responded = turnUpdates(acp.updates).length
      acp.server.send(
        durableEvent("session.execution.started", { sessionID: "ses_background" }),
        permissionAsked("ses_background", "perm_background", {
          action: "read",
          metadata: { path: "/workspace/notes.md" },
        }),
        textDelta("ses_background", "msg_background", "late"),
        succeeded("ses_background"),
        permissionAsked("ses_background", "perm_after_end", { action: "read" }),
      )
      await acp.until(() => acp.server.replies.length === 2, "child permission replies")
      expect(turnUpdates(acp.updates).slice(responded)).toEqual([])
      expect((await acp.prompt(acp.sessionId, "again")).stopReason).toBe("end_turn")

      expect(turnUpdates(acp.updates).map((item) => item.update)).toMatchObject(row.parent)
      expect(acp.childUpdates).toMatchObject(row.child)
      expect(acp.permissions).toMatchObject([
        {
          sessionId: acp.sessionId,
          toolCall: {
            toolCallId: "ses_grandchild:call_read",
            title: "Deeper: /workspace/src/index.ts",
            _meta: grandchild,
          },
        },
        {
          sessionId: acp.sessionId,
          toolCall: {
            toolCallId: "ses_background:perm_background",
            title: "Research: /workspace/notes.md",
            _meta: {
              "opencode/child-session": { id: "ses_background", parentID: acp.sessionId, depth: 1, title: "Research" },
            },
          },
        },
      ])
      expect(acp.server.replies).toEqual([
        { sessionID: "ses_grandchild", requestID: "perm_child", decision: "once" },
        { sessionID: "ses_background", requestID: "perm_background", decision: "once" },
      ])
    },
  )

  test("streams resumed parent turns after background children report across prompts", async () => {
    await using acp = await startSession({
      permission: () => ({ outcome: { outcome: "selected", optionId: "once" } }),
      onPrompt: ({ sessionID, id, text }) => {
        if (text === "launch")
          return turn(
            sessionID,
            id,
            childCreated("ses_first", sessionID, "First"),
            childCreated("ses_second", sessionID, "Second"),
          )
        if (text === "followup")
          return turn(sessionID, id, durableEvent("session.execution.started", { sessionID: "ses_first" }))
        return turn(
          sessionID,
          id,
          textDelta("ses_second", "msg_child_2", "older child during chat"),
          textDelta(sessionID, "msg_chat", "chat reply"),
        )
      },
    })
    const sessionID = acp.sessionId

    expect((await acp.prompt(sessionID, "launch")).stopReason).toBe("end_turn")
    acp.server.send(
      textDelta("ses_first", "msg_child", "child only"),
      succeeded("ses_first"),
      ...turn(sessionID, "msg_report_1", textDelta(sessionID, "msg_reaction_1", "first reaction")),
      textDelta(sessionID, "msg_stale", "stale"),
    )
    await acp.waitForUpdate(({ update }) => JSON.stringify(update).includes("first reaction"))

    expect((await acp.prompt(sessionID, "chat")).stopReason).toBe("end_turn")
    acp.server.send(
      permissionAsked("ses_second", "perm_second", { action: "read" }),
      succeeded("ses_second"),
      ...turn(sessionID, "msg_report_2", textDelta(sessionID, "msg_reaction_2", "second reaction")),
    )
    await acp.waitForUpdate(({ update }) => JSON.stringify(update).includes("second reaction"))
    await acp.until(() => acp.server.replies.length === 1, "second child permission reply")

    expect((await acp.prompt(sessionID, "followup")).stopReason).toBe("end_turn")
    acp.server.send(
      succeeded("ses_first"),
      ...turn(sessionID, "msg_report_3", textDelta(sessionID, "msg_reaction_3", "followup reaction")),
    )
    await acp.waitForUpdate(({ update }) => JSON.stringify(update).includes("followup reaction"))

    expect(acp.server.replies).toEqual([{ sessionID: "ses_second", requestID: "perm_second", decision: "once" }])
    expect(turnUpdates(acp.updates).map(({ update }) => update)).toMatchObject([
      { messageId: "msg_reaction_1", content: { text: "first reaction" } },
      { messageId: "msg_chat", content: { text: "chat reply" } },
      { messageId: "msg_reaction_2", content: { text: "second reaction" } },
      { messageId: "msg_reaction_3", content: { text: "followup reaction" } },
    ])
  })

  test.each(["job", "inbox", "active", "unavailable"] as const)(
    "streams a background shell response while its completion is in %s",
    async (phase) => {
      let pending = true
      let owner = ""
      await using acp = await startSession({
        fetch(request) {
          const sessionID = owner
          if (pending && phase === "unavailable" && request.path === "/api/experimental/job")
            return new Response(null, { status: 503 })
          if (request.path === "/api/experimental/job")
            return Response.json({
              data:
                pending && phase === "job"
                  ? [
                      {
                        kind: "shell",
                        id: "sh_background",
                        shellID: "sh_background",
                        sessionID,
                        command: "build",
                        status: "running",
                        time: { started: 1 },
                      },
                    ]
                  : [],
            })
          if (request.path === `/api/session/${sessionID}/inbox`)
            return Response.json({
              data:
                pending && phase === "inbox"
                  ? [
                      {
                        id: "msg_shell_notice",
                        sessionID,
                        type: "synthetic",
                        payload: { text: "completed" },
                        delivery: "steer",
                        time: { created: 2 },
                      },
                    ]
                  : [],
            })
          if (request.path === "/api/session/active")
            return Response.json({ data: pending && phase === "active" ? { [sessionID]: { type: "running" } } : {} })
        },
        onPrompt: ({ sessionID, id, text }) => {
          owner = sessionID
          if (text === "chat") return turn(sessionID, id, textDelta(sessionID, "msg_chat", "chat reply"))
          return turn(
            sessionID,
            id,
            toolStarted(sessionID, "call_shell", "shell"),
            toolCalled(sessionID, "call_shell", { command: "build", background: true }),
            toolSucceeded(sessionID, "call_shell", { shellID: "sh_background", status: "running" }, "backgrounded"),
          )
        },
      })
      const idleStreams = acp.server.eventStreams
      expect((await acp.prompt(acp.sessionId, "launch")).stopReason).toBe("end_turn")
      expect((await acp.prompt(acp.sessionId, "chat")).stopReason).toBe("end_turn")
      pending = false
      acp.server.send(
        ...turn(acp.sessionId, "msg_shell_notice", textDelta(acp.sessionId, "msg_reaction", "shell reaction")),
      )
      await acp.waitForUpdate(({ update }) => JSON.stringify(update).includes("shell reaction"))
      await acp.until(() => acp.server.eventStreams === idleStreams, "background subscription cleanup")
    },
  )

  test("closes an ordinary turn without metadata or background lookups", async () => {
    await using acp = await startSession({
      onPrompt: ({ sessionID, id }) =>
        turn(
          sessionID,
          id,
          toolStarted(sessionID, "call_read", "read"),
          toolCalled(sessionID, "call_read", {}),
          toolSucceeded(sessionID, "call_read", undefined, "finished"),
        ),
    })
    const idleStreams = acp.server.eventStreams
    expect((await acp.prompt(acp.sessionId, "read")).stopReason).toBe("end_turn")
    await acp.until(() => acp.server.eventStreams === idleStreams, "ordinary subscription cleanup")
    expect(acp.server.requests.filter((request) => request.path === "/api/experimental/job")).toHaveLength(0)
  })

  test("cancels unsupported session forms so execution can continue", async () => {
    await using acp = await startSession({
      onPrompt: ({ sessionID, id }) => [
        delivered(sessionID, id),
        ephemeralEvent("form.created", {
          form: {
            id: "frm_question",
            sessionID,
            title: "Questions",
            metadata: { kind: "question" },
            fields: [{ key: "q0", title: "Choice", type: "string" }],
          },
        }),
      ],
      onFormCancel: ({ sessionID, formID }) => [
        ephemeralEvent("form.cancelled", { sessionID, id: formID }),
        succeeded(sessionID),
      ],
    })

    expect((await acp.prompt(acp.sessionId, "hello")).stopReason).toBe("end_turn")
    expect(acp.server.cancelledForms).toEqual([
      { sessionID: acp.sessionId, formID: "frm_question", message: ACPElicitation.UnshownQuestionMessage },
    ])
    expect(acp.elicitations).toEqual([])
  })

  test("steers a running session and leaves an idle one alone", async () => {
    await using acp = await startSession()
    const steer = () =>
      acp.requestExt("_session/steering", { sessionId: acp.sessionId, prompt: [{ type: "text", text: "redirect" }] })

    expect(await steer()).toEqual({ outcome: "promptRequired", reason: "noRunningTurn" })
    expect(acp.server.submissions).toEqual([])

    acp.server.active.add(acp.sessionId)
    expect(await steer()).toEqual({ outcome: "injected" })
    expect(acp.server.prompts).toEqual([
      expect.objectContaining({ text: "redirect", delivery: "steer", resume: false }),
    ])
  })
})

function turnUpdates(updates: readonly SessionNotification[]) {
  return updates.filter(
    (item) => item.update.sessionUpdate !== "available_commands_update" && item.update.sessionUpdate !== "usage_update",
  )
}
