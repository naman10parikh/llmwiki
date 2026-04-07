// Video processor — extracts audio track via ffmpeg, then transcribes
// Requires: ffmpeg installed, plus Whisper/Deepgram for transcription

export interface VideoResult {
  title: string;
  transcript: string;
  duration?: number;
  sourcePath: string;
  keyFrames?: string[];
}

export async function processVideo(filePath: string): Promise<VideoResult> {
  // TODO: Implement ffmpeg audio extraction + Whisper transcription
  throw new Error(
    'Video processing requires ffmpeg and Whisper/Deepgram. ' +
    'Enable in config.yaml under processing.video.',
  );
}
