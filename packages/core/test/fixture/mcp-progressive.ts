import { Server } from "@modelcontextprotocol/server"
import { StdioServerTransport } from "@modelcontextprotocol/server/stdio"

const server = new Server({ name: "progressive", version: "1.0.0" }, { capabilities: { tools: { listChanged: true } } })
let enabled = false

server.setRequestHandler("tools/list", () =>
  Promise.resolve({
    tools: [
      { name: "toggle", inputSchema: { type: "object" as const, properties: { enabled: { type: "boolean" } } } },
      ...(enabled ? [{ name: "added", inputSchema: { type: "object" as const } }] : []),
    ],
  }),
)
server.setRequestHandler("tools/call", async (request) => {
  if (request.params.name === "toggle") {
    enabled = request.params.arguments?.enabled === true
    await server.sendToolListChanged()
  }
  return { content: [{ type: "text", text: request.params.name }] }
})

await server.connect(new StdioServerTransport())
