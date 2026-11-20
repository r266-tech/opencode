import { expect } from "bun:test"
import { Plugin } from "@opencode/core/plugin"
import { PluginHost } from "@opencode/core/plugin/host"
import { PluginPromise } from "@opencode/core/plugin/promise"
import { Effect } from "effect"
import { testEffect } from "../lib/effect"
import { PluginTestLayer } from "./fixture"

const it = testEffect(PluginTestLayer)

it.live("Promise plugins receive a diagnostic for a conflicting synthetic input ID", () =>
  Effect.gen(function* () {
    const plugins = yield* Plugin.Service
    const context = yield* PluginHost.make(plugins, "test")
    const source = yield* context.session.create({ title: "Source session" })
    const target = yield* context.session.create({ title: "Target session" })

    yield* PluginPromise.fromPromise({
      id: "test.session-synthetic",
      async setup(ctx) {
        const admitted = await ctx.session.synthetic({ sessionID: source.id, text: "Completed", resume: false })
        await expect(
          ctx.session.synthetic({ id: admitted.id, sessionID: target.id, text: "Completed", resume: false }),
        ).rejects.toThrow(`Cannot admit synthetic input ${admitted.id} to session ${target.id}: ID already in use`)
      },
    }).effect(context)
  }),
)
