import { expect, test } from "bun:test"
import { permissionPresentation } from "../../src/util/permission"

test.each([
  {
    name: "rewritten command",
    resources: ['git commit --trailer "X: rewritten" -m "test"'],
    input: { command: 'git commit -m "test"' },
    lines: ['$ git commit --trailer "X: rewritten" -m "test"'],
  },
  {
    name: "multiple authorized commands",
    resources: ["echo rewritten", "pwd"],
    input: { command: "echo original" },
    lines: ["$ echo rewritten", "$ pwd"],
  },
  {
    name: "no stored tool input",
    resources: ["echo authorized"],
    input: undefined,
    lines: ["$ echo authorized"],
  },
  {
    name: "no resources",
    resources: [],
    input: { command: "echo original" },
    lines: ["$ echo original"],
  },
])("shell permission displays $name", ({ resources, input, lines }) => {
  expect(permissionPresentation({ action: "shell", resources, input })).toMatchObject({
    title: "Shell command",
    lines,
  })
})

test("preserves permission roots and self-contained metadata", () => {
  expect(permissionPresentation({ action: "external_directory", resources: ["/*"] }).title).toBe(
    "Access external directory /",
  )
  expect(permissionPresentation({ action: "external_directory", resources: ["C:/*"] }).title).toBe(
    "Access external directory C:/",
  )
  expect(
    permissionPresentation({ action: "webfetch", resources: [], metadata: { url: "https://example.com" } }),
  ).toMatchObject({
    title: "WebFetch https://example.com",
    lines: ["URL: https://example.com"],
  })
  expect(permissionPresentation({ action: "websearch", resources: [], metadata: { query: "releases" } })).toMatchObject(
    {
      title: 'Web Search "releases"',
      lines: ["Query: releases"],
    },
  )
})
