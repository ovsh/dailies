/** OpenRouter-backed text embedder. */
import type { TextEmbedder } from "../../shared/types";
import { EMBEDDING_DIM, EMBEDDING_MODEL } from "../../shared/types";
import type { OpenRouterClient } from "./openrouter-client";

const EMBED_BATCH_SIZE = 100;

function l2Normalize(values: number[]): Float32Array {
  let sumSq = 0;
  for (const value of values) sumSq += value * value;
  const norm = Math.sqrt(sumSq);
  const out = new Float32Array(values.length);
  if (norm === 0) return out;
  for (let i = 0; i < values.length; i += 1) out[i] = values[i] / norm;
  return out;
}

export function createOpenRouterEmbedder(client: OpenRouterClient): TextEmbedder {
  return {
    async embed(texts: string[]): Promise<Float32Array[]> {
      const vectors: Float32Array[] = [];
      for (let i = 0; i < texts.length; i += EMBED_BATCH_SIZE) {
        const batch = texts.slice(i, i + EMBED_BATCH_SIZE);
        const embeddings = await client.embed(EMBEDDING_MODEL, batch, EMBEDDING_DIM);
        if (embeddings.length !== batch.length) {
          throw new Error(`OpenRouter returned ${embeddings.length} embeddings for ${batch.length} inputs`);
        }
        for (const embedding of embeddings) {
          if (embedding.length !== EMBEDDING_DIM) {
            throw new Error(
              `OpenRouter returned embedding dimension ${embedding.length}; expected ${EMBEDDING_DIM}`,
            );
          }
          vectors.push(l2Normalize(embedding));
        }
      }
      return vectors;
    },
  };
}
