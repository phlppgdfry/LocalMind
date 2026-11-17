import { describe, expect, it } from "vitest";
import { formatBytes, isLocalChatModel, parseNdjson, splitThinking, statsFromDone, titleFrom, validateChatRequest } from "../lib/ollama";

describe("parseNdjson", () => {
  it("returns complete events and keeps a partial line for the next chunk", () => {
    const { events, rest } = parseNdjson('{"a":1}\n{"b":2}\n{"c":');
    expect(events).toEqual([{ a: 1 }, { b: 2 }]);
    expect(rest).toBe('{"c":');
    expect(parseNdjson(rest + "3}\n").events).toEqual([{ c: 3 }]);
  });
  it("skips malformed lines instead of throwing", () => {
    expect(parseNdjson('nope\n{"ok":true}\n').events).toEqual([{ ok: true }]);
  });
});

describe("splitThinking", () => {
  it("separates finished reasoning from the answer", () => {
    expect(splitThinking("<think>plan</think>\n\nHello")).toEqual({ thinking: "plan", answer: "Hello", thinkingOpen: false });
  });
  it("handles reasoning that is still streaming", () => {
    expect(splitThinking("<think>still going")).toEqual({ thinking: "still going", answer: "", thinkingOpen: true });
  });
  it("leaves normal answers alone", () => {
    expect(splitThinking("Just text")).toEqual({ thinking: "", answer: "Just text", thinkingOpen: false });
  });
});

describe("statsFromDone", () => {
  it("converts Ollama nanoseconds into tokens per second", () => {
    expect(statsFromDone({ eval_count: 100, eval_duration: 2e9, total_duration: 2.5e9 }, 300)).toEqual({ tokens: 100, tokensPerSecond: 50, firstTokenMs: 300, totalMs: 2500 });
  });
  it("never divides by zero", () => {
    expect(statsFromDone({}).tokensPerSecond).toBe(0);
  });
});

describe("model filtering and validation", () => {
  it("hides embedding and cloud models from the chat picker", () => {
    expect(isLocalChatModel("nomic-embed-text:latest", ["nomic-bert"])).toBe(false);
    expect(isLocalChatModel("gemma4:31b-cloud")).toBe(false);
    expect(isLocalChatModel("qwen3:8b", ["qwen3"])).toBe(true);
  });
  it("rejects bad chat requests with a readable reason", () => {
    expect(validateChatRequest({ model: "qwen3:8b", messages: [{ role: "user", content: "hi" }] })).toBeNull();
    expect(validateChatRequest({ model: "rm -rf /", messages: [{ role: "user", content: "hi" }] })).toMatch(/model/);
    expect(validateChatRequest({ model: "qwen3:8b", messages: [] })).toMatch(/at least one/);
    expect(validateChatRequest({ model: "qwen3:8b", messages: [{ role: "system", content: "x" }] })).toMatch(/Malformed/);
  });
  it("formats sizes and titles", () => {
    expect(formatBytes(5.2 * 1024 ** 3)).toBe("5.2 GB");
    expect(formatBytes(0)).toBe("cloud");
    expect(titleFrom("  Write a haiku   about the sea ")).toBe("Write a haiku about the sea");
    expect(titleFrom("x".repeat(80))).toHaveLength(41);
  });
});
