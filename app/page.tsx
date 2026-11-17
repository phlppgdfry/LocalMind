"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { formatBytes, parseNdjson, splitThinking, statsFromDone, titleFrom, type ChatMessage } from "@/lib/ollama";

interface Model { name: string; size: number; parameters: string; quantization: string }
interface Conversation { id: string; title: string; model: string; messages: ChatMessage[]; updatedAt: number }
type Status = "checking" | "online" | "offline";

const STORAGE_KEY = "localmind.conversations.v1";
const QUICK_PROMPTS = [
  { icon: "✍️", label: "Rewrite an email", prompt: "Rewrite this email so it is friendly, short and clear:\n\n" },
  { icon: "🧩", label: "Explain code", prompt: "Explain what this code does, step by step, and point out one risk:\n\n" },
  { icon: "📋", label: "Summarise", prompt: "Summarise the text below in three bullet points and one sentence of advice:\n\n" },
  { icon: "💡", label: "Brainstorm", prompt: "Give me five concrete, low-cost ideas to automate repetitive admin work for a small business." },
];

const load = (): Conversation[] => {
  try { return JSON.parse(localStorage.getItem(STORAGE_KEY) || "[]"); } catch { return []; }
};
const save = (all: Conversation[]) => {
  try { localStorage.setItem(STORAGE_KEY, JSON.stringify(all.slice(0, 50))); } catch { /* storage full or blocked: chat still works */ }
};
const newId = () => Math.random().toString(36).slice(2, 10);

export default function Home() {
  const [status, setStatus] = useState<Status>("checking");
  const [models, setModels] = useState<Model[]>([]);
  const [model, setModel] = useState("");
  const [conversations, setConversations] = useState<Conversation[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [input, setInput] = useState("");
  const [streaming, setStreaming] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const abortRef = useRef<AbortController | null>(null);
  const bottomRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);

  const active = conversations.find((c) => c.id === activeId) ?? null;
  const messages = useMemo(() => active?.messages ?? [], [active]);

  const refreshModels = useCallback(async () => {
    setStatus("checking");
    try {
      const res = await fetch("/api/models", { cache: "no-store" });
      const data: { online: boolean; models: Model[] } = await res.json();
      setStatus(data.online ? "online" : "offline");
      setModels(data.models);
      let saved: string | null = null;
      try { saved = localStorage.getItem("localmind.model"); } catch { /* private mode */ }
      const installed = (name: string | null) => !!name && data.models.some((m) => m.name === name);
      setModel((current) => (installed(current) ? current : installed(saved) ? saved! : data.models[0]?.name ?? ""));
    } catch {
      setStatus("offline");
    }
  }, []);

  useEffect(() => {
    // localStorage only exists after hydration; reading it here avoids a server/client mismatch.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setConversations(load());
    refreshModels();
  }, [refreshModels]);

  useEffect(() => { bottomRef.current?.scrollIntoView({ behavior: "smooth", block: "end" }); }, [messages]);
  useEffect(() => { if (model) try { localStorage.setItem("localmind.model", model); } catch {} }, [model]);

  const updateConversations = (fn: (all: Conversation[]) => Conversation[]) => {
    setConversations((all) => { const next = fn(all); save(next); return next; });
  };

  function stop() { abortRef.current?.abort(); }

  function newChat() {
    stop();
    setActiveId(null);
    setError(null);
    setSidebarOpen(false);
    setTimeout(() => inputRef.current?.focus(), 0);
  }

  async function send(text: string) {
    const content = text.trim();
    if (!content || streaming || !model) return;
    setError(null);
    setInput("");

    const id = activeId ?? newId();
    const history: ChatMessage[] = [...messages, { role: "user", content }];
    updateConversations((all) => {
      const others = all.filter((c) => c.id !== id);
      const existing = all.find((c) => c.id === id);
      return [{ id, title: existing?.title ?? titleFrom(content), model, messages: [...history, { role: "assistant", content: "" }], updatedAt: Date.now() }, ...others];
    });
    setActiveId(id);

    const setAssistant = (patch: Partial<ChatMessage>) =>
      updateConversations((all) => all.map((c) => {
        if (c.id !== id) return c;
        const msgs = [...c.messages];
        msgs[msgs.length - 1] = { ...msgs[msgs.length - 1], ...patch };
        return { ...c, messages: msgs, updatedAt: Date.now() };
      }));

    const controller = new AbortController();
    abortRef.current = controller;
    setStreaming(true);
    const started = performance.now();
    let firstTokenMs: number | undefined;
    let answer = "";
    let thinking = "";

    try {
      const res = await fetch("/api/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ model, messages: history }),
        signal: controller.signal,
      });
      if (!res.ok || !res.body) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data.error ?? `Request failed (${res.status})`);
      }
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        const parsed = parseNdjson(buffer + decoder.decode(value, { stream: true }));
        buffer = parsed.rest;
        for (const event of parsed.events as { message?: { content?: string; thinking?: string }; done?: boolean; error?: string; eval_count?: number; eval_duration?: number; total_duration?: number }[]) {
          if (event.error) throw new Error(event.error);
          const piece = event.message?.content ?? "";
          const thought = event.message?.thinking ?? "";
          if ((piece || thought) && firstTokenMs === undefined) firstTokenMs = Math.round(performance.now() - started);
          answer += piece;
          thinking += thought;
          const split = splitThinking(answer);
          setAssistant({ content: split.answer, thinking: (thinking + split.thinking).trim() || undefined });
          if (event.done) setAssistant({ stats: statsFromDone(event, firstTokenMs) });
        }
      }
    } catch (err) {
      if ((err as Error).name === "AbortError") {
        setAssistant({ content: (splitThinking(answer).answer + "\n\n_— stopped_").trim() });
      } else {
        setError((err as Error).message);
        updateConversations((all) => all.map((c) => (c.id === id ? { ...c, messages: c.messages.slice(0, -1) } : c)));
        setInput(content);
      }
    } finally {
      setStreaming(false);
      abortRef.current = null;
      inputRef.current?.focus();
    }
  }

  function deleteConversation(id: string) {
    updateConversations((all) => all.filter((c) => c.id !== id));
    if (id === activeId) setActiveId(null);
  }

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && streaming) stop();
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") { e.preventDefault(); newChat(); }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  const current = models.find((m) => m.name === model);

  return (
    <div className="flex h-dvh bg-[var(--bg)] text-[var(--ink)]">
      {/* Sidebar: conversations stay in this browser only */}
      <aside className={`${sidebarOpen ? "flex" : "hidden"} md:flex fixed md:static inset-y-0 left-0 z-20 w-72 flex-col border-r border-[var(--line)] bg-[var(--panel)]`}>
        <div className="flex items-center gap-2 px-4 pt-4 pb-3">
          <Logo />
          <div>
            <p className="font-semibold leading-tight">LocalMind</p>
            <p className="text-xs text-[var(--muted)]">Runs on this Mac</p>
          </div>
        </div>
        <div className="px-3">
          <button onClick={newChat} className="w-full rounded-xl border border-[var(--line)] px-3 py-2 text-left text-sm hover:border-[var(--accent)] flex justify-between">
            <span>＋ New chat</span><kbd className="text-xs text-[var(--muted)]">⌘K</kbd>
          </button>
        </div>
        <nav className="mt-3 flex-1 overflow-y-auto px-2" aria-label="Conversations">
          {conversations.length === 0 && <p className="px-2 py-4 text-xs text-[var(--muted)]">Your chats appear here. They are stored in this browser only.</p>}
          {conversations.map((c) => (
            <div key={c.id} className={`group flex items-center rounded-lg ${c.id === activeId ? "bg-[var(--chip)]" : "hover:bg-[var(--chip)]"}`}>
              <button onClick={() => { setActiveId(c.id); setSidebarOpen(false); setError(null); }} className="flex-1 truncate px-3 py-2 text-left text-sm" title={c.title}>
                {c.title}
              </button>
              <button onClick={() => deleteConversation(c.id)} aria-label={`Delete ${c.title}`} className="px-2 text-[var(--muted)] opacity-0 group-hover:opacity-100 focus:opacity-100 hover:text-red-400">✕</button>
            </div>
          ))}
        </nav>
        <PrivacyNote />
      </aside>
      {sidebarOpen && <button className="fixed inset-0 z-10 bg-black/40 md:hidden" aria-label="Close menu" onClick={() => setSidebarOpen(false)} />}

      <main className="flex min-w-0 flex-1 flex-col">
        <header className="flex items-center gap-3 border-b border-[var(--line)] px-4 py-3">
          <button className="md:hidden rounded-lg border border-[var(--line)] px-2 py-1" onClick={() => setSidebarOpen(true)} aria-label="Open conversations">☰</button>
          <StatusPill status={status} onRetry={refreshModels} count={models.length} />
          <div className="ml-auto flex items-center gap-2">
            <label htmlFor="model" className="hidden sm:block text-xs text-[var(--muted)]">Model</label>
            <select id="model" value={model} onChange={(e) => setModel(e.target.value)} disabled={!models.length || streaming}
              className="max-w-[60vw] rounded-lg border border-[var(--line)] bg-[var(--panel)] px-3 py-1.5 text-sm">
              {!models.length && <option>No models</option>}
              {models.map((m) => <option key={m.name} value={m.name}>{m.name} · {m.parameters || formatBytes(m.size)}</option>)}
            </select>
          </div>
        </header>

        <section className="flex-1 overflow-y-auto" aria-live="polite">
          <div className="mx-auto max-w-3xl px-4 py-6 space-y-6">
            {status === "offline" && <OfflineHelp onRetry={refreshModels} />}
            {status === "online" && models.length === 0 && <NoModelsHelp onRetry={refreshModels} />}
            {messages.length === 0 && status !== "offline" && models.length > 0 && (
              <div className="pt-[8vh] text-center">
                <Logo big />
                <h1 className="mt-4 text-2xl font-semibold">What can I help with?</h1>
                <p className="mt-1 text-sm text-[var(--muted)]">
                  {current ? <>Answering with <b className="text-[var(--ink)]">{current.name}</b> ({formatBytes(current.size)}) — nothing leaves this Mac.</> : "Pick a model to start."}
                </p>
                <div className="mt-8 grid gap-3 sm:grid-cols-2 text-left">
                  {QUICK_PROMPTS.map((q) => (
                    <button key={q.label} onClick={() => { if (q.prompt.endsWith("\n\n")) { setInput(q.prompt); inputRef.current?.focus(); } else send(q.prompt); }}
                      className="rounded-2xl border border-[var(--line)] bg-[var(--panel)] p-4 text-left hover:border-[var(--accent)] transition">
                      <span className="text-lg">{q.icon}</span>
                      <p className="mt-1 font-medium text-sm">{q.label}</p>
                      <p className="text-xs text-[var(--muted)] line-clamp-2">{q.prompt.trim()}</p>
                    </button>
                  ))}
                </div>
              </div>
            )}
            {messages.map((m, i) => (
              <Message key={i} message={m} live={streaming && i === messages.length - 1} model={active?.model} />
            ))}
            {error && (
              <div role="alert" className="rounded-xl border border-red-500/40 bg-red-500/10 px-4 py-3 text-sm">
                <b>Couldn’t get an answer.</b> {error}
              </div>
            )}
            <div ref={bottomRef} />
          </div>
        </section>

        <footer className="border-t border-[var(--line)] px-4 py-3">
          <form className="mx-auto flex max-w-3xl items-end gap-2" onSubmit={(e) => { e.preventDefault(); send(input); }}>
            <textarea ref={inputRef} value={input} rows={Math.min(6, Math.max(1, input.split("\n").length))}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) { e.preventDefault(); send(input); } }}
              placeholder={status === "offline" ? "Start Ollama to chat…" : "Message LocalMind  (Enter to send, Shift+Enter for a new line)"}
              aria-label="Message" disabled={status === "offline"}
              className="flex-1 resize-none rounded-2xl border border-[var(--line)] bg-[var(--panel)] px-4 py-3 text-sm focus:border-[var(--accent)] focus:outline-none disabled:opacity-60" />
            {streaming ? (
              <button type="button" onClick={stop} className="rounded-2xl border border-[var(--line)] px-4 py-3 text-sm font-medium" title="Stop (Esc)">■ Stop</button>
            ) : (
              <button type="submit" disabled={!input.trim() || !model} className="rounded-2xl bg-[var(--accent)] px-5 py-3 text-sm font-medium text-[var(--accent-ink)] disabled:opacity-40">Send</button>
            )}
          </form>
        </footer>
      </main>
    </div>
  );
}

function Message({ message, live, model }: { message: ChatMessage; live: boolean; model?: string }) {
  const [copied, setCopied] = useState(false);
  if (message.role === "user") {
    return (
      <div className="flex justify-end">
        <div className="max-w-[85%] whitespace-pre-wrap rounded-2xl rounded-br-md bg-[var(--accent)] px-4 py-2.5 text-sm text-[var(--accent-ink)]">{message.content}</div>
      </div>
    );
  }
  const thinkingLive = live && !message.content;
  return (
    <div className="group">
      {message.thinking && (
        <details className="mb-2 text-sm" open={thinkingLive}>
          <summary className="cursor-pointer select-none text-[var(--muted)]">{thinkingLive ? "Thinking…" : "Show reasoning"}</summary>
          <div className="mt-2 whitespace-pre-wrap border-l-2 border-[var(--line)] pl-3 text-xs text-[var(--muted)]">{message.thinking}</div>
        </details>
      )}
      {message.content ? (
        <div className="prose-chat text-sm"><ReactMarkdown remarkPlugins={[remarkGfm]}>{message.content}</ReactMarkdown></div>
      ) : (
        !message.thinking && live && <div className="flex gap-1 py-2" aria-label="Waiting for the model"><Dot /><Dot d="150ms" /><Dot d="300ms" /></div>
      )}
      {!live && message.content && (
        <div className="mt-2 flex items-center gap-3 text-xs text-[var(--muted)]">
          <button onClick={() => { navigator.clipboard?.writeText(message.content).then(() => { setCopied(true); setTimeout(() => setCopied(false), 1200); }); }} className="hover:text-[var(--ink)]">{copied ? "Copied" : "Copy"}</button>
          {message.stats && (
            <span title="Measured by Ollama on this machine">
              {model ? `${model} · ` : ""}{message.stats.tokensPerSecond} tok/s · {message.stats.tokens} tokens
              {message.stats.firstTokenMs !== undefined ? ` · first token ${(message.stats.firstTokenMs / 1000).toFixed(1)}s` : ""}
            </span>
          )}
        </div>
      )}
    </div>
  );
}

function StatusPill({ status, count, onRetry }: { status: Status; count: number; onRetry: () => void }) {
  const label = status === "online" ? `Ollama online · ${count} model${count === 1 ? "" : "s"}` : status === "offline" ? "Ollama offline" : "Checking Ollama…";
  const color = status === "online" ? "bg-emerald-400" : status === "offline" ? "bg-red-400" : "bg-amber-400 animate-pulse";
  return (
    <button onClick={onRetry} className="flex items-center gap-2 rounded-full border border-[var(--line)] px-3 py-1 text-xs" title="Check again">
      <span className={`h-2 w-2 rounded-full ${color}`} />{label}
    </button>
  );
}

function OfflineHelp({ onRetry }: { onRetry: () => void }) {
  return (
    <div className="rounded-2xl border border-[var(--line)] bg-[var(--panel)] p-6">
      <h2 className="font-semibold">Ollama isn’t running</h2>
      <p className="mt-1 text-sm text-[var(--muted)]">LocalMind talks to the Ollama server on this machine. Start it, then check again:</p>
      <pre className="mt-3 rounded-xl bg-[var(--chip)] p-3 text-xs">brew install ollama{"\n"}ollama serve{"\n"}ollama pull qwen3:1.7b</pre>
      <button onClick={onRetry} className="mt-3 rounded-lg bg-[var(--accent)] px-3 py-1.5 text-sm text-[var(--accent-ink)]">Check again</button>
    </div>
  );
}

function NoModelsHelp({ onRetry }: { onRetry: () => void }) {
  return (
    <div className="rounded-2xl border border-[var(--line)] bg-[var(--panel)] p-6">
      <h2 className="font-semibold">No chat models installed yet</h2>
      <p className="mt-1 text-sm text-[var(--muted)]">Pull a small model (1.4 GB) and check again:</p>
      <pre className="mt-3 rounded-xl bg-[var(--chip)] p-3 text-xs">ollama pull qwen3:1.7b</pre>
      <button onClick={onRetry} className="mt-3 rounded-lg bg-[var(--accent)] px-3 py-1.5 text-sm text-[var(--accent-ink)]">Check again</button>
    </div>
  );
}

function PrivacyNote() {
  return (
    <div className="m-3 rounded-xl bg-[var(--chip)] p-3 text-xs text-[var(--muted)]">
      🔒 Prompts go from this page to Ollama on <code>127.0.0.1</code>. No cloud API, no analytics. History lives in this browser’s storage.
    </div>
  );
}

function Logo({ big = false }: { big?: boolean }) {
  const s = big ? 48 : 32;
  return (
    <svg width={s} height={s} viewBox="0 0 32 32" aria-hidden className={big ? "mx-auto" : ""}>
      <rect width="32" height="32" rx="9" fill="var(--accent)" />
      <circle cx="16" cy="16" r="7" fill="none" stroke="var(--accent-ink)" strokeWidth="2.5" />
      <circle cx="16" cy="16" r="2.5" fill="var(--accent-ink)" />
    </svg>
  );
}

function Dot({ d = "0ms" }: { d?: string }) {
  return <span className="h-2 w-2 animate-bounce rounded-full bg-[var(--muted)]" style={{ animationDelay: d }} />;
}
