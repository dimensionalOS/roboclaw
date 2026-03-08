import { execFileSync } from "node:child_process";
import net from "node:net";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk";
import { Type } from "@sinclair/typebox";
import type { AnyAgentTool } from "openclaw/agents/tools/common.js";

const DEFAULT_HOST = "127.0.0.1";
const DEFAULT_PORT = 9990;
const CALL_TIMEOUT_MS = 30_000;

interface McpToolDef {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

interface McpConnection {
  client: net.Socket;
  nextId: number;
  pending: Map<number, { resolve: (value: unknown) => void; reject: (reason: Error) => void }>;
  buf: string;
  initialized: boolean;
}

const connections = new Map<string, McpConnection>();

function getConnectionKey(host: string, port: number): string {
  return `${host}:${port}`;
}

function getOrCreateConnection(host: string, port: number): Promise<McpConnection> {
  const key = getConnectionKey(host, port);
  const existing = connections.get(key);
  if (existing && !existing.client.destroyed) {
    return Promise.resolve(existing);
  }

  return new Promise((resolve, reject) => {
    const conn: McpConnection = {
      client: net.createConnection(port, host),
      nextId: 1,
      pending: new Map(),
      buf: "",
      initialized: false,
    };

    const onConnect = () => {
      const id = conn.nextId++;
      conn.client.write(
        JSON.stringify({
          jsonrpc: "2.0",
          id,
          method: "initialize",
          params: {
            protocolVersion: "2024-11-05",
            capabilities: {},
            clientInfo: { name: "openclaw-dimos", version: "0.0.1" },
          },
        }) + "\n",
      );
      conn.pending.set(id, {
        resolve: () => {
          conn.initialized = true;
          connections.set(key, conn);
          resolve(conn);
        },
        reject,
      });
    };

    conn.client.on("connect", onConnect);

    conn.client.on("data", (d) => {
      conn.buf += d.toString();
      const lines = conn.buf.split("\n");
      conn.buf = lines.pop() || "";
      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          const msg = JSON.parse(line) as { id?: number; result?: unknown; error?: { message: string } };
          if (msg.id != null) {
            const p = conn.pending.get(msg.id);
            if (p) {
              conn.pending.delete(msg.id);
              if (msg.error) {
                p.reject(new Error(msg.error.message));
              } else {
                p.resolve(msg.result);
              }
            }
          }
        } catch {
          // ignore malformed JSON lines
        }
      }
    });

    conn.client.on("error", (err) => {
      connections.delete(key);
      for (const p of conn.pending.values()) {
        p.reject(err);
      }
      conn.pending.clear();
      reject(err);
    });

    conn.client.on("close", () => {
      connections.delete(key);
      const closeErr = new Error("Connection closed");
      for (const p of conn.pending.values()) {
        p.reject(closeErr);
      }
      conn.pending.clear();
    });
  });
}

async function sendRequest(conn: McpConnection, method: string, params: Record<string, unknown>): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const id = conn.nextId++;
    const timer = setTimeout(() => {
      conn.pending.delete(id);
      reject(new Error(`MCP request '${method}' timed out`));
    }, CALL_TIMEOUT_MS);

    conn.pending.set(id, {
      resolve: (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      reject: (err) => {
        clearTimeout(timer);
        reject(err);
      },
    });

    conn.client.write(
      JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n",
    );
  });
}

function getHost(pluginConfig?: Record<string, unknown>): string {
  if (pluginConfig && typeof pluginConfig.mcpHost === "string" && pluginConfig.mcpHost) {
    return pluginConfig.mcpHost;
  }
  return DEFAULT_HOST;
}

function getPort(pluginConfig?: Record<string, unknown>): number {
  if (pluginConfig && typeof pluginConfig.mcpPort === "number") {
    return pluginConfig.mcpPort;
  }
  return DEFAULT_PORT;
}

/** Convert a JSON Schema properties object into a TypeBox Type.Object schema. */
function jsonSchemaToTypebox(
  inputSchema?: Record<string, unknown>,
): ReturnType<typeof Type.Object> {
  if (!inputSchema) {
    return Type.Object({});
  }

  const properties = (inputSchema.properties ?? {}) as Record<string, Record<string, unknown>>;
  const required = new Set((inputSchema.required ?? []) as string[]);
  const tbProps: Record<string, unknown> = {};

  for (const [key, prop] of Object.entries(properties)) {
    const desc = typeof prop.description === "string" ? prop.description : undefined;
    let inner;
    switch (prop.type) {
      case "number":
      case "integer":
        inner = Type.Number({ description: desc });
        break;
      case "boolean":
        inner = Type.Boolean({ description: desc });
        break;
      case "array":
        inner = Type.Array(Type.Unknown(), { description: desc });
        break;
      case "object":
        inner = Type.Record(Type.String(), Type.Unknown(), { description: desc });
        break;
      default:
        inner = Type.String({ description: desc });
        break;
    }
    tbProps[key] = required.has(key) ? inner : Type.Optional(inner);
  }

  // @ts-expect-error -- heterogeneous property map built dynamically
  return Type.Object(tbProps);
}

/**
 * Discover MCP tools synchronously by connecting directly to the DimOS TCP server.
 * Uses a child process so we can block the main thread during plugin registration.
 */
function discoverToolsSync(host: string, port: number): McpToolDef[] {
  const script = `
const net = require('net');
const client = net.createConnection(${port}, ${JSON.stringify(host)}, () => {
  client.write(JSON.stringify({jsonrpc:'2.0',id:1,method:'initialize',params:{protocolVersion:'2024-11-05',capabilities:{},clientInfo:{name:'openclaw-dimos',version:'0.0.1'}}})+'\\n');
});
let buf='';
client.on('data',d=>{
  buf+=d.toString();
  const lines=buf.split('\\n');
  buf=lines.pop()||'';
  for(const line of lines){
    if(!line.trim())continue;
    const msg=JSON.parse(line);
    if(msg.id===1){
      client.write(JSON.stringify({jsonrpc:'2.0',id:2,method:'tools/list',params:{}})+'\\n');
    }else if(msg.id===2){
      process.stdout.write(JSON.stringify(msg.result.tools));
      client.end();
    }
  }
});
client.on('error',e=>{process.stderr.write(e.message);process.exit(1);});
`;
  const result = execFileSync("node", ["-e", script], {
    timeout: 10_000,
    encoding: "utf-8",
  });
  return JSON.parse(result);
}

/** Call an MCP tool via persistent TCP connection to the DimOS server. */
async function callTool(
  host: string,
  port: number,
  name: string,
  args: Record<string, unknown>,
): Promise<string> {
  const conn = await getOrCreateConnection(host, port);
  const result = (await sendRequest(conn, "tools/call", { name, arguments: args })) as {
    content?: Array<{ type: string; text?: string }>;
  };
  const content = result?.content;
  if (Array.isArray(content)) {
    return (
      content
        .filter((c) => c.type === "text")
        .map((c) => c.text)
        .join("\n") || "OK"
    );
  }
  return JSON.stringify(content) || "OK";
}

export default {
  id: "dimos",
  name: "Dimos MCP Bridge",
  description: "Exposes tools from the dimos MCP server as OpenClaw agent tools",

  register(api: OpenClawPluginApi) {
    const host = getHost(api.pluginConfig);
    const port = getPort(api.pluginConfig);

    // Discover tools synchronously so they're available immediately —
    // no dependency on the service lifecycle (which the CLI agent path skips).
    let mcpTools: McpToolDef[];
    try {
      mcpTools = discoverToolsSync(host, port);
      api.logger.info(`dimos: discovered ${mcpTools.length} tool(s) from ${host}:${port}`);
    } catch (err) {
      api.logger.error(`dimos: failed to discover tools from ${host}:${port}: ${err}`);
      return;
    }

    // Register each tool with a proper name so OpenClaw's tool system tracks them.
    for (const mcpTool of mcpTools) {
      const parameters = jsonSchemaToTypebox(mcpTool.inputSchema);
      const tool: AnyAgentTool = {
        name: mcpTool.name,
        label: mcpTool.name,
        description: mcpTool.description || "",
        parameters,
        async execute(
          _toolCallId: string,
          params: Record<string, unknown>,
        ): Promise<{ content: Array<{ type: "text"; text: string }>; details: unknown }> {
          const text = await callTool(host, port, mcpTool.name, params);
          return {
            content: [{ type: "text" as const, text }],
            details: { tool: mcpTool.name, params },
          };
        },
      };
      api.registerTool(tool, { name: mcpTool.name });
    }
  },
};
