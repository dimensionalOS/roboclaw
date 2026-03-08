import { execFileSync } from "node:child_process";
import net from "node:net";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk";
import { Type } from "@sinclair/typebox";
import type { AnyAgentTool } from "openclaw/agents/tools/common.js";

const DEFAULT_HOST = "127.0.0.1";
const DEFAULT_PORT = 9990;
const CALL_TIMEOUT_MS = 30_000;
const DISCOVERY_MAX_RETRIES = 3;
const DISCOVERY_RETRY_DELAY_MS = 2_000;

interface McpToolDef {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
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

/** Call an MCP tool via direct TCP connection to the DimOS server. */
async function callTool(
  host: string,
  port: number,
  name: string,
  args: Record<string, unknown>,
): Promise<string> {
  return new Promise((resolve, reject) => {
    const client = net.createConnection(port, host, () => {
      client.write(
        JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "initialize",
          params: {
            protocolVersion: "2024-11-05",
            capabilities: {},
            clientInfo: { name: "openclaw-dimos", version: "0.0.1" },
          },
        }) + "\n",
      );
    });

    let buf = "";
    let phase: "init" | "call" | "done" = "init";

    const timer = setTimeout(() => {
      client.destroy();
      reject(new Error("MCP tool call timed out"));
    }, CALL_TIMEOUT_MS);

    client.on("data", (d) => {
      buf += d.toString();
      const lines = buf.split("\n");
      buf = lines.pop() || "";
      for (const line of lines) {
        if (!line.trim()) continue;
        const msg = JSON.parse(line);
        if (phase === "init" && msg.id === 1) {
          phase = "call";
          client.write(
            JSON.stringify({
              jsonrpc: "2.0",
              id: 2,
              method: "tools/call",
              params: { name, arguments: args },
            }) + "\n",
          );
        } else if (phase === "call" && msg.id === 2) {
          phase = "done";
          clearTimeout(timer);
          if (msg.error) {
            resolve(`Error: ${msg.error.message}`);
          } else {
            const content = msg.result?.content;
            const text = Array.isArray(content)
              ? content
                  .filter((c: { type: string }) => c.type === "text")
                  .map((c: { text: string }) => c.text)
                  .join("\n")
              : JSON.stringify(content);
            resolve(text || "OK");
          }
          client.end();
        }
      }
    });

    client.on("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });
  });
}

export default {
  id: "dimos",
  name: "Dimos MCP Bridge",
  description: "Exposes tools from the dimos MCP server as OpenClaw agent tools",

  register(api: OpenClawPluginApi) {
    const host = getHost(api.pluginConfig);
    const port = getPort(api.pluginConfig);

    let mcpTools: McpToolDef[] | null = null;
    for (let attempt = 1; attempt <= DISCOVERY_MAX_RETRIES; attempt++) {
      try {
        mcpTools = discoverToolsSync(host, port);
        api.logger.info(`dimos: discovered ${mcpTools.length} tool(s) from ${host}:${port}`);
        break;
      } catch (err) {
        api.logger.error(
          `dimos: discovery attempt ${attempt}/${DISCOVERY_MAX_RETRIES} failed for ${host}:${port}: ${err}`,
        );
        if (attempt < DISCOVERY_MAX_RETRIES) {
          Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, DISCOVERY_RETRY_DELAY_MS);
        }
      }
    }
    if (!mcpTools) {
      api.logger.error(`dimos: all ${DISCOVERY_MAX_RETRIES} discovery attempts failed, plugin not loaded`);
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
