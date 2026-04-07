// Audio processor — transcribes audio files to markdown using Whisper or Deepgram
// Requires: whisper CLI (local) or DEEPGRAM_API_KEY (API)

export interface AudioResult {
  title: string;
  transcript: string;
  duration?: number;
  sourcePath: string;
}

export async function processAudio(filePath: string): Promise<AudioResult> {
  // TODO: Implement Whisper/Deepgram transcription
  // For now, return a placeholder indicating the feature needs configuration
  throw new Error(
    'Audio processing requires Whisper (local) or Deepgram API key. ' +
    'Enable in config.yaml under processing.audio.',
  );
}
