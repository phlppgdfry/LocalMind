import { OLLAMA_URL, validateChatRequest, type ChatMessage } from "@/lib/ollama";

// Streams Ollama's NDJSON straight through to the browser: first token appears in
// milliseconds instead of after the whole answer, and Stop aborts generation on the Mac.
export async function POST(req: Request) {
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return Response.json({ error: "Body must be JSON." }, { status: 400 });
  }
  const problem = validateChatRequest(body);
  if (problem) return Response.json({ error: problem }, { status: 400 });

  const { model, messages } = body as { model: string; messages: ChatMessage[] };
  let upstream: Response;
  try {
    upstream = await fetch(`${OLLAMA_URL}/api/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model,
        stream: true,
        // Only role + content go to the model: earlier reasoning is not re-sent as context.
        messages: messages.map(({ role, content }) => ({ role, content })),
      }),
      signal: req.signal,
    });
  } catch {
    return Response.json({ error: "Ollama is not reachable. Start it with `ollama serve`." }, { status: 502 });
  }
  if (!upstream.ok || !upstream.body) {
    const detail = await upstream.text().catch(() => "");
    const message = /not found/i.test(detail) ? `Model "${model}" is not installed. Run \`ollama pull ${model}\`.` : `Ollama error ${upstream.status}.`;
    return Response.json({ error: message }, { status: 502 });
  }
  return new Response(upstream.body, {
    headers: { "Content-Type": "application/x-ndjson; charset=utf-8", "Cache-Control": "no-store" },
  });
}
