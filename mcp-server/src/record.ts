export const DEFAULT_FPS = 2;
export const MAX_FPS = 10;
export const DEFAULT_MAX_FRAMES = 300;

/**
 * Holds the frames of an in-progress recording. Capped so a session that
 * forgets to stop cannot grow without bound: at the cap we keep what we have
 * and say so, rather than dropping the recording or eating memory.
 */
export class Recorder {
  private frames: Buffer[] = [];
  private recording = false;
  private fps = DEFAULT_FPS;
  private maxFrames = DEFAULT_MAX_FRAMES;
  private capped = false;

  start(fps: number, maxFrames: number): void {
    this.frames = [];
    this.recording = true;
    this.capped = false;
    this.fps = fps;
    this.maxFrames = maxFrames;
  }

  addFrame(png: Buffer): void {
    if (!this.recording) return;
    if (this.frames.length >= this.maxFrames) {
      this.capped = true;
      return;
    }
    this.frames.push(png);
  }

  stop(): Buffer[] {
    const frames = this.frames;
    this.frames = [];
    this.recording = false;
    return frames;
  }

  isRecording(): boolean {
    return this.recording;
  }

  frameCount(): number {
    return this.frames.length;
  }

  hitCap(): boolean {
    return this.capped;
  }

  intervalMs(): number {
    return Math.round(1000 / this.fps);
  }
}
