import { expect } from "bun:test"
import { Context, Deferred, Effect, Fiber, Layer, Stream } from "effect"
import { Browser } from "@opencode/plugin-browser/rpc"
import type { Permission } from "@opencode/schema/permission"
import { AppNodeBuilder } from "@opencode/core/effect/app-node-builder"
import { LayerNode } from "@opencode/util/effect/layer-node"
import { Global } from "@opencode/util/global"
import { Bus } from "@opencode/core/bus"
import { Database } from "@opencode/core/database/database"
import { Location } from "@opencode/core/location"
import { LocationServiceMap } from "@opencode/core/location-services"
import { Plugin } from "@opencode/core/plugin"
import { Rpc } from "@opencode/core/rpc"
import { AbsolutePath } from "@opencode/core/schema"
import { Session } from "@opencode/core/session"
import { Tool } from "@opencode/core/tool"
import { Agent } from "@opencode/schema/agent"
import { SessionMessage } from "@opencode/schema/session-message"
import { join } from "node:path"
import { pathToFileURL } from "node:url"
import { tempGlobalLayer } from "./fixture/global"
import { offlineModels } from "./fixture/models"
import { tmpdirScoped } from "./fixture/tmpdir"
import { testEffect } from "./lib/effect"

// The browser plugin's `session.permissions` writes, as the test orders them.
const writes: {
  /**
   * While set, a revoke reads the session, then waits until a grant has written; that grant waits until the revoke has
   * read. This is the interleaving that loses a replacement's grant to its predecessor's stale revoke.
   */
  race?: { readonly revokeRead: Deferred.Deferred<void>; readonly granted: Deferred.Deferred<void> }
  /** Completes when a revoke write finishes. */
  revoked: Deferred.Deferred<void>
} = { revoked: Deferred.makeUnsafe() }

const isGrant = (permissions: Permission.Ruleset) =>
  permissions.some((rule) => rule.action === "browser" && rule.effect === "allow")

const orderedWrites = Session.node.replace(
  Session.node.mapLayer((base) =>
    Layer.effect(
      Session.Service,
      Effect.map(Session.Service, (sessions) =>
        Session.Service.of({
          ...sessions,
          setPermissions: (input) => {
            const race = writes.race
            if (isGrant(input.permissions))
              return race
                ? Deferred.await(race.revokeRead).pipe(
                    Effect.andThen(sessions.setPermissions(input)),
                    Effect.ensuring(Deferred.succeed(race.granted, undefined)),
                  )
                : sessions.setPermissions(input)
            const revoked = writes.revoked
            return (
              race
                ? Deferred.succeed(race.revokeRead, undefined).pipe(
                    Effect.andThen(Deferred.await(race.granted)),
                    Effect.andThen(sessions.setPermissions(input)),
                  )
                : sessions.setPermissions(input)
            ).pipe(Effect.ensuring(Deferred.succeed(revoked, undefined)))
          },
        }),
      ),
    ).pipe(Layer.provide(base)),
  ),
)

const it = testEffect(
  AppNodeBuilder.build(LayerNode.group([Database.node, Bus.node, Session.node, LocationServiceMap.node]), [
    Global.node.replace(tempGlobalLayer),
    offlineModels,
    orderedWrites,
  ]),
)

const user = { action: "bash", resource: "*", effect: "ask" } as const
const allows = [
  { action: "browser", resource: "*", effect: "allow" },
  { action: "skill", resource: "browser", effect: "allow" },
] as const

const setup = Effect.gen(function* () {
  writes.race = undefined
  writes.revoked = Deferred.makeUnsafe()
  const dir = yield* tmpdirScoped()
  const ref = Location.Ref.make({ directory: AbsolutePath.make(dir.path) })
  const locations = yield* LocationServiceMap.Service
  const context = yield* locations.contextEffect(ref).pipe(Effect.scoped)
  yield* Plugin.awaitActivation.pipe(Effect.provideContext(context))
  const sessions = yield* Session.Service
  const session = yield* sessions.create({ location: ref, permissions: [user] })
  const rpc = Context.get(context, Rpc.Service).client(Browser.Definition)
  const handshakes = new Map<string, Deferred.Deferred<void>>()
  const handshake = (connectionID: string) => {
    const existing = handshakes.get(connectionID)
    if (existing) return existing
    const created = Deferred.makeUnsafe<void>()
    handshakes.set(connectionID, created)
    return created
  }
  yield* rpc.events.subscribe("control").pipe(
    Stream.runForEach((event) =>
      event.data.type === "attached" ? Deferred.succeed(handshake(event.data.connectionID), undefined) : Effect.void,
    ),
    Effect.forkScoped({ startImmediately: true }),
  )
  return {
    ref,
    locations,
    session,
    rpc,
    tools: Context.get(context, Tool.Service),
    attach: (connectionID: string) =>
      rpc.attach({ sessionID: session.id, connectionID, version: 4 }).pipe(Effect.forkScoped),
    attached: (connectionID: string) => Deferred.await(handshake(connectionID)).pipe(Effect.timeout("10 seconds")),
    permissions: Effect.map(sessions.get(session.id), (info) => info.permissions ?? []),
  }
})

it.live("preview validates server-local files before sending them to the desktop", () =>
  Effect.gen(function* () {
    const browser = yield* setup
    const attachment = { sessionID: browser.session.id, connectionID: "conn_preview" }
    yield* browser.attach(attachment.connectionID)
    yield* browser.attached(attachment.connectionID)
    const paths: string[] = []
    yield* browser.rpc.events.subscribe("control").pipe(
      Stream.runForEach((event) =>
        Effect.gen(function* () {
          if (event.data.type !== "command") return
          const request = { ...attachment, requestID: event.data.requestID }
          const command = yield* browser.rpc.command(request)
          if (command.action.type !== "preview") throw new Error("Expected a preview command")
          paths.push(command.action.path)
          yield* browser.rpc.result({
            ...request,
            outcome: { type: "success", result: { value: { path: command.action.path }, files: [] } },
          })
        }),
      ),
      Effect.forkScoped({ startImmediately: true }),
    )
    const tool = (yield* browser.tools.list()).find(
      (tool) => tool.name === "preview" && tool.options?.namespace === "browser",
    )
    if (!tool) throw new Error("Browser preview tool is not registered")
    const reference = yield* tmpdirScoped()
    const absolute = join(reference.path, "reference file.html")
    const url = pathToFileURL(absolute).href
    yield* Effect.promise(() =>
      Promise.all([
        Bun.write(join(browser.ref.directory, "present.html"), "workspace"),
        Bun.write(absolute, "reference"),
      ]),
    )
    for (const entry of [
      { path: "absent.html", ok: false },
      { path: browser.ref.directory, ok: false },
      { path: "present.html", ok: true },
      { path: "present.html#L1", ok: true },
      { path: "present.html:1:1", ok: true },
      { path: absolute, ok: true },
      { path: url, ok: true },
    ]) {
      const result = yield* tool
        .execute(
          { path: entry.path },
          {
            sessionID: browser.session.id,
            agent: Agent.ID.make("build"),
            messageID: SessionMessage.ID.make("msg_browser_preview"),
            id: Tool.CallID.make("call_preview"),
            progress: () => Effect.void,
          },
        )
        .pipe(
          Effect.match({
            onSuccess: (value) => ({ ok: true as const, value }),
            onFailure: (error) => ({ ok: false as const, error }),
          }),
        )
      expect(result.ok).toBe(entry.ok)
      if (result.ok) expect(result.value.output).toEqual({ path: entry.path })
      if (!result.ok) expect(result.error.message).toContain("Cannot preview file on the server")
    }
    expect(paths).toEqual(["present.html", "present.html#L1", "present.html:1:1", absolute, url])
  }),
)

it.live("a replaced attachment's revoke never removes its replacement's grant", () =>
  Effect.gen(function* () {
    const browser = yield* setup
    const first = yield* browser.attach("conn_1")
    yield* browser.attached("conn_1")
    expect(yield* browser.permissions).toEqual([user, ...allows])

    const race = { revokeRead: Deferred.makeUnsafe<void>(), granted: Deferred.makeUnsafe<void>() }
    writes.race = race
    const second = yield* browser.attach("conn_2")
    expect(yield* Fiber.join(first)).toBe("replaced")
    yield* browser.attached("conn_2")
    // A revoke for conn_1, if one ran, was held until conn_2's grant wrote; let it land before reading.
    if (yield* Deferred.isDone(race.revokeRead)) yield* Deferred.await(writes.revoked)
    expect(yield* browser.permissions).toEqual([user, ...allows])

    writes.race = undefined
    writes.revoked = Deferred.makeUnsafe()
    yield* Fiber.interrupt(second)
    yield* Deferred.await(writes.revoked).pipe(Effect.timeout("10 seconds"))
    expect(yield* browser.permissions).toEqual([user])
  }),
)

it.live("disposing the plugin revokes the browser rules before the location finishes closing", () =>
  Effect.gen(function* () {
    const browser = yield* setup
    yield* browser.attach("conn_1")
    yield* browser.attached("conn_1")
    expect(yield* browser.permissions).toEqual([user, ...allows])

    yield* browser.locations.invalidate(browser.ref)
    expect(yield* browser.permissions).toEqual([user])
  }),
)
