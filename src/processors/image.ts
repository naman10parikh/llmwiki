// Image processor — describes images using vision-capable LLM
// Requires: Claude or GPT with vision capabilities

export interface ImageResult {
  title: string;
  description: string;
  sourcePath: string;
}

export async function processImage(filePath: string): Promise<ImageResult> {
  // TODO: Implement vision model image description
  throw new Error(
    'Image processing requires a vision-capable LLM (Claude or GPT). ' +
    'Enable in config.yaml under processing.image.',
  );
}
