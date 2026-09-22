/** pgvector's text input format for a `vector` column/literal: `[v1,v2,...]`. */
export function toVectorLiteral(embedding: number[]): string {
  return `[${embedding.join(",")}]`;
}
