import { describe, expect, it } from "vitest";
import { parseSimpleToml, serializeSimpleToml } from "./toml";

describe("simple TOML provider config", () => {
  it("parses strings, numbers, booleans and inline comments", () => {
    expect(parseSimpleToml('model = "demo"\ncontext_window = 128K\n# ignored\nenabled = true # comment')).toEqual({
      model: "demo",
      context_window: "128K",
      enabled: true,
    });
  });

  it("round-trips escaped strings", () => {
    const source = { base_url: "https://example.test/v1", extra_headers: '{\n  "X-Trace": "demo"\n}' };
    expect(parseSimpleToml(serializeSimpleToml(source))).toEqual(source);
  });

  it("rejects malformed, duplicate and structured values", () => {
    expect(() => parseSimpleToml("model \"demo\"")).toThrow("缺少");
    expect(() => parseSimpleToml('model = "a"\nmodel = "b"')).toThrow("重复");
    expect(() => parseSimpleToml("headers = { key = \"value\" }")).toThrow("数组或对象");
  });
});
