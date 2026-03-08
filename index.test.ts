import { describe, it, expect } from "vitest";
import { getHost, getPort, jsonSchemaToTypebox } from "./index.js";
import { Type, Kind, OptionalKind } from "@sinclair/typebox";

describe("getHost", () => {
  it("returns default host when no config", () => {
    expect(getHost()).toBe("127.0.0.1");
    expect(getHost(undefined)).toBe("127.0.0.1");
  });

  it("returns default host when config has no mcpHost", () => {
    expect(getHost({})).toBe("127.0.0.1");
    expect(getHost({ mcpHost: 123 })).toBe("127.0.0.1");
    expect(getHost({ mcpHost: "" })).toBe("127.0.0.1");
  });

  it("returns custom host from config", () => {
    expect(getHost({ mcpHost: "192.168.1.100" })).toBe("192.168.1.100");
  });
});

describe("getPort", () => {
  it("returns default port when no config", () => {
    expect(getPort()).toBe(9990);
    expect(getPort(undefined)).toBe(9990);
  });

  it("returns default port when config has no mcpPort", () => {
    expect(getPort({})).toBe(9990);
    expect(getPort({ mcpPort: "9991" })).toBe(9990);
  });

  it("returns custom port from config", () => {
    expect(getPort({ mcpPort: 8080 })).toBe(8080);
  });
});

describe("jsonSchemaToTypebox", () => {
  it("returns empty object schema for undefined input", () => {
    const schema = jsonSchemaToTypebox(undefined);
    expect(schema[Kind]).toBe("Object");
    expect(schema.properties).toEqual({});
  });

  it("returns empty object schema for schema without properties", () => {
    const schema = jsonSchemaToTypebox({ type: "object" });
    expect(schema.properties).toEqual({});
  });

  it("converts string property", () => {
    const schema = jsonSchemaToTypebox({
      properties: { name: { type: "string", description: "A name" } },
      required: ["name"],
    });
    expect(schema.properties).toHaveProperty("name");
    expect(schema.properties.name[Kind]).toBe("String");
    expect(schema.properties.name.description).toBe("A name");
  });

  it("converts number and integer properties", () => {
    const schema = jsonSchemaToTypebox({
      properties: {
        speed: { type: "number" },
        count: { type: "integer" },
      },
      required: ["speed", "count"],
    });
    expect(schema.properties.speed[Kind]).toBe("Number");
    expect(schema.properties.count[Kind]).toBe("Number");
  });

  it("converts boolean property", () => {
    const schema = jsonSchemaToTypebox({
      properties: { enabled: { type: "boolean" } },
      required: ["enabled"],
    });
    expect(schema.properties.enabled[Kind]).toBe("Boolean");
  });

  it("marks properties not in required array as optional", () => {
    const schema = jsonSchemaToTypebox({
      properties: {
        req: { type: "string" },
        opt: { type: "string" },
      },
      required: ["req"],
    });
    // Required property has no Optional symbol
    expect(schema.properties.req[OptionalKind]).toBeUndefined();
    // Non-required property has Optional symbol
    expect(schema.properties.opt[OptionalKind]).toBe("Optional");
  });

  it("converts array property", () => {
    const schema = jsonSchemaToTypebox({
      properties: { items: { type: "array" } },
      required: ["items"],
    });
    expect(schema.properties.items[Kind]).toBe("Array");
  });

  it("converts object property to Record", () => {
    const schema = jsonSchemaToTypebox({
      properties: { metadata: { type: "object" } },
      required: ["metadata"],
    });
    expect(schema.properties.metadata[Kind]).toBe("Record");
  });

  it("defaults unknown types to string", () => {
    const schema = jsonSchemaToTypebox({
      properties: { unknown: { type: "foobar" } },
      required: ["unknown"],
    });
    expect(schema.properties.unknown[Kind]).toBe("String");
  });
});
