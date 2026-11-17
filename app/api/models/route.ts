import { OLLAMA_URL, isLocalChatModel } from "@/lib/ollama";

interface TagsResponse {
  models?: { name: string; size: number; details?: { family?: string; families?: string[]; parameter_size?: string; quantization_level?: string } }[];
}

export async function GET() {
  try {
    const res = await fetch(`${OLLAMA_URL}/api/tags`, { signal: AbortSignal.timeout(2500), cache: "no-store" });
    if (!res.ok) throw new Error(`Ollama answered ${res.status}`);
    const data = (await res.json()) as TagsResponse;
    const models = (data.models ?? [])
      .filter((m) => isLocalChatModel(m.name, m.details?.families ?? []))
      .map((m) => ({
        name: m.name,
        size: m.size,
        parameters: m.details?.parameter_size ?? "",
        quantization: m.details?.quantization_level ?? "",
      }))
      .sort((a, b) => a.size - b.size);
    return Response.json({ online: true, models });
  } catch {
    return Response.json({ online: false, models: [] });
  }
}
