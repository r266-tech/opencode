import { describe, expect } from "bun:test"
import { Effect } from "effect"
import { asc, eq } from "drizzle-orm"
import { Bus } from "@opencode/core/bus"
import { Database } from "@opencode/core/database/database"
import { AppNodeBuilder } from "@opencode/core/effect/app-node-builder"
import { EventSequenceTable } from "@opencode/core/event/sql"
import { ProjectTable } from "@opencode/core/project/sql"
import { SessionProjector } from "@opencode/core/session/projector"
import { SessionInboxTable, SessionMessageTable } from "@opencode/core/session/sql"
import { SessionStore } from "@opencode/core/session/store"
import { Agent } from "@opencode/schema/agent"
import { Event } from "@opencode/schema/event"
import { Location } from "@opencode/schema/location"
import { Model } from "@opencode/schema/model"
import { Project } from "@opencode/schema/project"
import { Provider } from "@opencode/schema/provider"
import { AbsolutePath } from "@opencode/schema/schema"
import { Session } from "@opencode/schema/session"
import { SessionEvent } from "@opencode/schema/session-event"
import { SessionMessage } from "@opencode/schema/session-message"
import { LayerNode } from "@opencode/util/effect/layer-node"
import { testEffect } from "./lib/effect"

const seedSession = Effect.gen(function* () {
  const bus = yield* Bus.Service
  const { db } = yield* Database.Service
  const sessionID = Session.ID.create()
  const location = Location.Ref.make({ directory: AbsolutePath.make("/project") })
  yield* db.insert(ProjectTable).values({ id: Project.ID.global, worktree: location.directory, sandboxes: [] }).run()
  yield* bus.publish(SessionEvent.Created, {
    sessionID,
    projectID: Project.ID.global,
    location,
    slug: "sequence-test",
    version: "test",
  })
  return { bus, db, sessionID }
})

for (const persist of [false, true]) {
  const it = testEffect(
    AppNodeBuilder.build(LayerNode.group([Database.node, Bus.node, SessionProjector.node, SessionStore.node]), [
      Bus.node.replace(Bus.configured({ persist })),
    ]),
  )

  describe(`session sequences with persistence ${persist}`, () => {
    for (const state of ["missing", "stale", "healthy", "reserved"] as const) {
      for (const batch of [false, true]) {
        it.effect(`appends ${batch ? "a batch" : "single events"} after ${state} projected history`, () =>
          Effect.gen(function* () {
            const { bus, db, sessionID } = yield* seedSession
            const store = yield* SessionStore.Service
            const agent = Agent.ID.make("build")
            const model = Model.Ref.make({ id: Model.ID.make("model"), providerID: Provider.ID.make("provider") })
            yield* bus.publish(SessionEvent.AgentSelected, { sessionID, agent })
            // Projected messages need not occupy every aggregate sequence.
            yield* Bus.reserveSequence(db, sessionID, 4)
            yield* bus.publish(SessionEvent.ModelSelected, { sessionID, model })
            yield* bus.claim(sessionID, "owner-a")
            const original = yield* db
              .select()
              .from(SessionMessageTable)
              .where(eq(SessionMessageTable.session_id, sessionID))
              .orderBy(asc(SessionMessageTable.seq))
              .all()
            expect(original.map((row) => row.seq)).toEqual([1, 5])

            if (state === "missing")
              yield* db.delete(EventSequenceTable).where(eq(EventSequenceTable.aggregate_id, sessionID)).run()
            if (state === "stale")
              yield* db
                .update(EventSequenceTable)
                .set({ seq: 1 })
                .where(eq(EventSequenceTable.aggregate_id, sessionID))
                .run()
            if (state === "reserved") yield* Bus.reserveSequence(db, sessionID, 10)

            const events = batch
              ? yield* bus.publishAll([
                  [SessionEvent.AgentSelected, { sessionID, agent }],
                  [SessionEvent.ModelSelected, { sessionID, model }],
                ])
              : [
                  yield* bus.publish(SessionEvent.AgentSelected, { sessionID, agent }),
                  yield* bus.publish(SessionEvent.ModelSelected, { sessionID, model }),
                ]
            const expected = (state === "reserved" ? [11, 12] : [6, 7]).map((seq) => Event.Seq.make(seq))
            expect(events.map((event) => event.durable?.seq)).toEqual(expected)
            const rows = yield* db
              .select()
              .from(SessionMessageTable)
              .where(eq(SessionMessageTable.session_id, sessionID))
              .orderBy(asc(SessionMessageTable.seq))
              .all()
            expect(rows.slice(0, 2)).toEqual(original)
            expect(rows.map((row) => row.seq)).toEqual([1, 5, ...expected])
            expect((yield* store.messages({ sessionID, order: "asc" })).map((message) => message.id)).toEqual(
              rows.map((row) => row.id),
            )
            expect(
              yield* db
                .select({ seq: EventSequenceTable.seq, ownerID: EventSequenceTable.owner_id })
                .from(EventSequenceTable)
                .where(eq(EventSequenceTable.aggregate_id, sessionID))
                .get(),
            ).toEqual({ seq: expected[1], ownerID: state === "missing" ? null : "owner-a" })
          }),
        )
      }
    }

    for (const batch of [false, true]) {
      it.effect(`appends ${batch ? "a batch" : "an input"} after pending input with a missing counter`, () =>
        Effect.gen(function* () {
          const { bus, db, sessionID } = yield* seedSession
          const item = { type: "user", delivery: "queue", payload: { text: "Pending" } } as const
          const first = SessionMessage.ID.create()
          yield* bus.publish(SessionEvent.InboxEnqueued, { sessionID, inboxID: first, item })
          yield* db.delete(EventSequenceTable).where(eq(EventSequenceTable.aggregate_id, sessionID)).run()
          const second = SessionMessage.ID.create()
          const third = SessionMessage.ID.create()
          const events = batch
            ? yield* bus.publishAll([
                [SessionEvent.InboxEnqueued, { sessionID, inboxID: second, item }],
                [SessionEvent.InboxEnqueued, { sessionID, inboxID: third, item }],
              ])
            : [yield* bus.publish(SessionEvent.InboxEnqueued, { sessionID, inboxID: second, item })]
          const expected = (batch ? [2, 3] : [2]).map((seq) => Event.Seq.make(seq))
          expect(events.map((event) => event.durable?.seq)).toEqual(expected)
          const rows = yield* db
            .select({ id: SessionInboxTable.id, seq: SessionInboxTable.enqueued_seq })
            .from(SessionInboxTable)
            .where(eq(SessionInboxTable.session_id, sessionID))
            .orderBy(asc(SessionInboxTable.enqueued_seq))
            .all()
          expect(rows).toEqual([
            { id: first, seq: 1 },
            { id: second, seq: 2 },
            ...(batch ? [{ id: third, seq: 3 }] : []),
          ])
        }),
      )
    }
  })
}
