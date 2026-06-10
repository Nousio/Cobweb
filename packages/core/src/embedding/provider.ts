export interface EmbeddingProvider {
  readonly model: string;
  readonly dim: number;
  embed(texts: string[]): Promise<Float32Array[]>;
}

export class NoopEmbeddingProvider implements EmbeddingProvider {
  readonly model = "disabled";
  readonly dim = 0;

  async embed(): Promise<Float32Array[]> {
    throw new Error("Embedding is disabled in phase one.");
  }
}
