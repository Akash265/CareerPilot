import type { Env } from "@ai-career/config";

export class EmbeddingProviderNotImplementedError extends Error {}

export async function embedTexts(
  env: Pick<Env, "EMBEDDING_PROVIDER" | "VOYAGE_API_KEY" | "VOYAGE_EMBEDDING_MODEL">,
  texts: string[]
): Promise<number[][]> {
  if (texts.length === 0) return [];
  if (env.EMBEDDING_PROVIDER !== "voyage") {
    throw new EmbeddingProviderNotImplementedError(
      `EMBEDDING_PROVIDER=${env.EMBEDDING_PROVIDER} has no implementation yet`
    );
  }
  const response = await fetch("https://api.voyageai.com/v1/embeddings", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${env.VOYAGE_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ input: texts, model: env.VOYAGE_EMBEDDING_MODEL }),
  });
  if (!response.ok) {
    throw new Error(`Voyage embeddings request failed: ${response.status} ${await response.text()}`);
  }
  const body = (await response.json()) as { data: { embedding: number[] }[] };
  return body.data.map((item) => item.embedding);
}
