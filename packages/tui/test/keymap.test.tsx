/** @jsxImportSource @opentui/solid */
import type { KeymapCommand } from "@opencode/plugin/tui/context"
import { TextareaRenderable } from "@opentui/core"
import { useKeymap } from "@opentui/keymap/solid"
import { testRender } from "@opentui/solid"
import { expect, test } from "bun:test"
import { createSignal } from "solid-js"
import { ConfigProvider, useConfig, type Info } from "../src/config"
import { Keymap } from "../src/context/keymap"
import { createTuiResolvedConfig } from "./fixture/tui-runtime"

test("textarea bindings follow config additions, changes and removal", async () => {
  let current: Info = {}
  let config!: ReturnType<typeof useConfig>
  let input!: TextareaRenderable
  let commands = 0

  function Harness() {
    config = useConfig()
    Keymap.createLayer(() => ({ commands: [{ bind: "ctrl+a", run: () => void commands++ }] }))
    return <textarea ref={(value) => (input = value)} height={4} />
  }

  const app = await testRender(
    () => (
      <ConfigProvider
        config={createTuiResolvedConfig()}
        service={{
          get: async () => current,
          update: async (update) => {
            const draft = structuredClone(current)
            update(draft)
            current = draft
            return draft
          },
        }}
      >
        <Keymap.Provider>
          <Harness />
        </Keymap.Provider>
      </ConfigProvider>
    ),
    { width: 40, height: 8, kittyKeyboard: true },
  )
  try {
    input.focus()
    input.setText("aaa\nbbbccc")
    input.cursorOffset = 7
    app.mockInput.pressKey("HOME")
    expect(input.cursorOffset).toBe(0)
    app.mockInput.pressKey("a", { ctrl: true })
    expect(commands).toBe(1)

    await config.update((draft) => {
      draft.keybinds = {
        "input.line.home": ["home", "ctrl+a"],
        "input.line.end": ["end", "ctrl+e"],
        "input.buffer.home": "ctrl+home",
        "input.buffer.end": "ctrl+end",
      }
    })
    input.cursorOffset = 7
    app.mockInput.pressKey("HOME")
    expect(input.cursorOffset).toBe(4)
    input.cursorOffset = 1
    app.mockInput.pressKey("END")
    expect(input.cursorOffset).toBe(3)
    app.mockInput.pressKey("END", { ctrl: true })
    expect(input.cursorOffset).toBe(10)
    app.mockInput.pressKey("HOME", { ctrl: true })
    expect(input.cursorOffset).toBe(0)
    app.mockInput.pressKey("a", { ctrl: true })
    expect(commands).toBe(2)

    await config.update((draft) => {
      draft.keybinds = { "input.buffer.end": "home" }
    })
    app.mockInput.pressKey("HOME")
    expect(input.cursorOffset).toBe(10)

    await config.update((draft) => {
      delete draft.keybinds
    })
    input.cursorOffset = 7
    app.mockInput.pressKey("HOME")
    expect(input.cursorOffset).toBe(0)
    app.mockInput.typeText("X")
    expect(input.plainText).toBe("Xaaa\nbbbccc")
    expect(app.renderer.currentFocusedEditor).toBe(input)
  } finally {
    app.renderer.destroy()
  }
})

test("legacy page key aliases compile as page keys", async () => {
  let read = () => ({ up: "", down: "" })

  function Harness() {
    const shortcuts = Keymap.useShortcuts()
    Keymap.createLayer(() => ({
      commands: [
        { id: "session.page.up", run() {} },
        { id: "session.page.down", run() {} },
      ],
    }))
    read = () => ({
      up: shortcuts.get("session.page.up") ?? "",
      down: shortcuts.get("session.page.down") ?? "",
    })
    return <box />
  }

  const app = await testRender(() => (
    <ConfigProvider
      config={createTuiResolvedConfig({
        keybinds: {
          "session.page.up": "pgup",
          "session.page.down": "pgdown",
        },
      })}
    >
      <Keymap.Provider>
        <Harness />
      </Keymap.Provider>
    </ConfigProvider>
  ))
  try {
    expect(read()).toEqual({ up: "pgup", down: "pgdn" })
  } finally {
    app.renderer.destroy()
  }
})

test("formats navigation keys as arrows", async () => {
  let read = () => ({}) as Record<string, string>
  const commands = ["session.parent", "session.child.first"]

  function Harness() {
    const shortcuts = Keymap.useShortcuts()
    Keymap.createLayer(() => ({
      commands: commands.map((id) => ({ id, run() {} })),
    }))
    read = () => Object.fromEntries(commands.map((id) => [id, shortcuts.get(id) ?? ""]))
    return <box />
  }

  const app = await testRender(() => (
    <ConfigProvider config={createTuiResolvedConfig()}>
      <Keymap.Provider>
        <Harness />
      </Keymap.Provider>
    </ConfigProvider>
  ))
  try {
    expect(read()).toEqual({
      "session.parent": "↑",
      "session.child.first": "↓",
    })
  } finally {
    app.renderer.destroy()
  }
})

test("returns every formatted command shortcut", async () => {
  let read = () => [] as readonly string[]

  function Harness() {
    const shortcuts = Keymap.useShortcuts()
    Keymap.createLayer(() => ({
      commands: [{ id: "demo.command", bind: "x,y", run() {} }],
    }))
    read = () => shortcuts.list("demo.command")
    return <box />
  }

  const app = await testRender(() => (
    <ConfigProvider config={createTuiResolvedConfig()}>
      <Keymap.Provider>
        <Harness />
      </Keymap.Provider>
    </ConfigProvider>
  ))
  try {
    expect(read()).toEqual(["x", "y"])
  } finally {
    app.renderer.destroy()
  }
})

test("re-registered commands keep their opencode object until its data changes", async () => {
  const [title, setTitle] = createSignal("Demo")
  const [description, setDescription] = createSignal<string | undefined>("Runs the demo")
  const [version, setVersion] = createSignal(0)
  let opencode = () => undefined as KeymapCommand | undefined
  let command = () => undefined as KeymapCommand | undefined

  function Harness() {
    const keymap = useKeymap()
    const commands = Keymap.useCommands()
    Keymap.createLayer(() => ({
      commands: [
        {
          id: "demo.command",
          title: title(),
          ...(description() === undefined ? {} : { description: description() }),
          palette: true,
          suggested: version() >= 0,
          run() {},
        },
      ],
    }))
    opencode = () =>
      keymap.getCommandEntries({ visibility: "registered" }).find((entry) => entry.command.name === "demo.command")
        ?.command.opencode
    command = () => commands().find((item) => item.id === "demo.command")
    return <box />
  }

  const app = await testRender(() => (
    <ConfigProvider config={createTuiResolvedConfig()}>
      <Keymap.Provider>
        <Harness />
      </Keymap.Provider>
    </ConfigProvider>
  ))
  try {
    const first = opencode()
    setVersion(1)
    expect(opencode()).toBe(first)

    setTitle("Renamed")
    expect(opencode()).not.toBe(first)
    expect(command()?.title).toBe("Renamed")

    setDescription(undefined)
    expect(command()?.description).toBeUndefined()
  } finally {
    app.renderer.destroy()
  }
})

test("re-registered commands keep inline slash objects until their fields change", async () => {
  const [aliases, setAliases] = createSignal(["d"])
  const [version, setVersion] = createSignal(0)
  let registered = () => undefined as { opencode?: unknown; slash?: unknown } | undefined
  let command = () => undefined as KeymapCommand | undefined

  function Harness() {
    const keymap = useKeymap()
    const commands = Keymap.useCommands()
    Keymap.createLayer(() => ({
      commands: [
        {
          id: "demo.slash",
          title: "Demo",
          suggested: version() >= 0,
          slash: { name: "demo", aliases: aliases(), arguments: true },
          run() {},
        },
      ],
    }))
    registered = () =>
      keymap.getCommandEntries({ visibility: "registered" }).find((entry) => entry.command.name === "demo.slash")
        ?.command
    command = () => commands().find((item) => item.id === "demo.slash")
    return <box />
  }

  const app = await testRender(() => (
    <ConfigProvider config={createTuiResolvedConfig()}>
      <Keymap.Provider>
        <Harness />
      </Keymap.Provider>
    </ConfigProvider>
  ))
  try {
    const first = registered()
    setVersion(1)
    expect(registered()?.opencode).toBe(first?.opencode)
    expect(registered()?.slash).toBe(first?.slash)

    setAliases(["d", "dm"])
    expect(registered()?.opencode).not.toBe(first?.opencode)
    expect(command()?.slash?.aliases).toEqual(["d", "dm"])
  } finally {
    app.renderer.destroy()
  }
})

test("global commands stay reachable when the mode changes", async () => {
  const calls: string[] = []
  let exercise = () => {}

  function Harness() {
    const keymap = Keymap.use()
    Keymap.createLayer(() => ({
      mode: "global",
      commands: [{ id: "session.list", run: () => void calls.push("global") }],
    }))
    Keymap.createLayer(() => ({
      commands: [{ id: "model.list", run: () => void calls.push("base") }],
    }))

    exercise = () => {
      keymap.dispatch("session.list")
      keymap.dispatch("model.list")
      const pop = keymap.mode.push("question")
      keymap.dispatch("session.list")
      keymap.dispatch("model.list")
      pop()
    }
    return <box />
  }

  const app = await testRender(() => (
    <ConfigProvider config={createTuiResolvedConfig()}>
      <Keymap.Provider>
        <Harness />
      </Keymap.Provider>
    </ConfigProvider>
  ))
  try {
    exercise()
    expect(calls).toEqual(["global", "base", "global"])
  } finally {
    app.renderer.destroy()
  }
})
