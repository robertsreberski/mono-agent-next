declare module "@yarflam/potion-base-8m" {
  export function embed(texts: string | readonly string[]): Promise<Float32Array[]>;
  export function cosineSimilarity(left: Float32Array, right: Float32Array): number;
}
