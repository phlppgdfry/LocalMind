// Pure helpers shared by the API routes and the UI. No I/O here, so everything is unit-tested.

// Not OLLAMA_HOST: Ollama itself reads that for its bind address (often "0.0.0.0", without a scheme).
export const OLLAMA_URL = (process.env.LOCALMIND_OLLAMA_URL || "http://127.0.0.1:11434").replace(/\/$/, "");

export type Role = "user" | "assistant";
export interface ChatMessage {
  role: Role;
  content: string;
  thinking?: string;
  stats?: GenerationStats;
}
export interface GenerationStats {
  tokens: number;
  tokensPerSecond: number;
  firstTokenMs?: number;
  totalMs: number;
}

/** Splits a raw NDJSON stream into complete JSON objects, keeping the unfinished tail. */
export function parseNdjson(buffer: string): { events: unknown[]; rest: string } {
  const lines = buffer.split("\n");
  const rest = lines.pop() ?? "";
  const events: unknown[] = [];
  for (const line of lines) {
    if (!line.trim()) continue;
    try {
      events.push(JSON.parse(line));
    } catch {
      // A malformed line is skipped rather than killing the whole answer.
    }
  }
  return { events, rest };
}

/**
 * Reasoning models (Qwen3, DeepSeek-R1) may put their reasoning inline as <think>…</think>.
 * Separates it from the answer, also while the closing tag has not streamed in yet.
 */
export function splitThinking(text: string): { thinking: string; answer: string; thinkingOpen: boolean } {
  const start = text.indexOf("<think>");
  if (start === -1) return { thinking: "", answer: text, thinkingOpen: false };
  const end = text.indexOf("</think>", start);
  if (end === -1) {
    return { thinking: text.slice(start + 7).trim(), answer: text.slice(0, start).trim(), thinkingOpen: true };
  }
  const answer = (text.slice(0, start) + text.slice(end + 8)).trim();
  return { thinking: text.slice(start + 7, end).trim(), answer, thinkingOpen: false };
}

/** Ollama reports durations in nanoseconds. */
export function statsFromDone(done: { eval_count?: number; eval_duration?: number; total_duration?: number }, firstTokenMs?: number): GenerationStats {
  const tokens = done.eval_count ?? 0;
  const evalSeconds = (done.eval_duration ?? 0) / 1e9;
  return {
    tokens,
    tokensPerSecond: evalSeconds > 0 ? Math.round((tokens / evalSeconds) * 10) / 10 : 0,
    firstTokenMs,
    totalMs: Math.round((done.total_duration ?? 0) / 1e6),
  };
}

export function formatBytes(bytes: number): string {
  if (!bytes) return "cloud";
  const gb = bytes / 1024 ** 3;
  return gb >= 1 ? `${gb.toFixed(1)} GB` : `${Math.round(bytes / 1024 ** 2)} MB`;
}

/** Embedding models cannot chat; cloud models do not run locally. Both are filtered from the picker. */
export function isLocalChatModel(name: string, families: string[] = []): boolean {
  if (/embed/i.test(name) || families.some((f) => /bert|embed/i.test(f))) return false;
  return !/-cloud$|:cloud$/i.test(name);
}

/** Validates the request body the UI sends; returns an error message or null. */
export function validateChatRequest(body: unknown): string | null {
  if (!body || typeof body !== "object") return "Body must be a JSON object.";
  const { model, messages } = body as { model?: unknown; messages?: unknown };
  if (typeof model !== "string" || !/^[\w.:/-]{1,100}$/.test(model)) return "Pick a valid model.";
  if (!Array.isArray(messages) || messages.length === 0) return "Send at least one message.";
  if (messages.length > 200) return "Conversation too long; start a new chat.";
  for (const m of messages) {
    if (!m || (m.role !== "user" && m.role !== "assistant") || typeof m.content !== "string") return "Malformed message.";
  }
  return null;
}

export function titleFrom(text: string): string {
  const clean = text.replace(/\s+/g, " ").trim();
  return clean.length > 42 ? clean.slice(0, 40).trimEnd() + "…" : clean || "New chat";
}
