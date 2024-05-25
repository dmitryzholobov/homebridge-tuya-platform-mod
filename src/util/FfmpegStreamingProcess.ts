import {
  ChildProcessWithoutNullStreams,
  spawn,
} from 'child_process';
import {
  StreamRequestCallback,
  StreamSessionIdentifier,
} from 'homebridge';
import os from 'os';
import readline from 'readline';
import { Writable } from 'stream';
import { PrefixLogger } from './Logger';

export interface StreamingDelegate {
    stopStream(sessionId: StreamSessionIdentifier): void;
    forceStopStream(sessionId: StreamSessionIdentifier): void;
}

type FfmpegProgress = {
    frame: number;
    fps: number;
    stream_q: number;
    bitrate: number;
    total_size: number;
    out_time_us: number;
    out_time: string;
    dup_frames: number;
    drop_frames: number;
    speed: number;
    progress: string;
};

export class FfmpegStreamingProcess {
  private readonly process: ChildProcessWithoutNullStreams;
  private killTimeout?: NodeJS.Timeout;
  readonly stdin: Writable;

  constructor(
    sessionId: string,
    videoProcessor: string,
    ffmpegArgs: string[],
    log: PrefixLogger,
    delegate: StreamingDelegate,
    callback?: StreamRequestCallback,
  ) {

    log.debug(`Stream command: ${videoProcessor} ${ffmpegArgs.map(value => JSON.stringify(value)).join(' ')}`);

    let started = false;
    const startTime = Date.now();

    this.process = spawn(videoProcessor, ffmpegArgs, { env: process.env });

    this.stdin = this.process.stdin;

    this.process.stdout.on('data', (data) => {
      const progress = this.parseProgress(data);
      if (progress) {
        if (!started && progress.frame > 0) {
          started = true;
          const runtime = (Date.now() - startTime) / 1000;
          const message = 'Getting the first frames took ' + runtime + ' seconds.';
          if (runtime < 5) {
            log.debug(message);
          } else if (runtime < 22) {
            log.warn(message);
          } else {
            log.error(message);
          }
        }
      }
    });
    const stderr = readline.createInterface({
      input: this.process.stderr,
      terminal: false,
    });
    stderr.on('line', (line: string) => {
      if (callback) {
        callback();
        callback = undefined;
      }
      if (line.match(/\[(panic|fatal|error)\]/)) {
        log.error(line);
      }
    });
    this.process.on('error', (error: Error) => {
      log.error('FFmpeg process creation failed: ' + error.message);
      if (callback) {
        callback(new Error('FFmpeg process creation failed'));
      }
      delegate.stopStream(sessionId);
    });
    this.process.on('exit', (code: number, signal: NodeJS.Signals) => {
      if (this.killTimeout) {
        clearTimeout(this.killTimeout);
      }

      const message = 'FFmpeg exited with code: ' + code + ' and signal: ' + signal;

      if (this.killTimeout && code === 0) {
        log.debug(message + ' (Expected)');
      } else if (code === null || code === 255) {
        if (this.process.killed) {
          log.debug(message + ' (Forced)');
        } else {
          log.error(message + ' (Unexpected)');
        }
      } else {
        log.error(message + ' (Error)');
        delegate.stopStream(sessionId);
        if (!started && callback) {
          callback(new Error(message));
        } else {
          delegate.forceStopStream(sessionId);
        }
      }
    });
  }

  parseProgress(data: Uint8Array): FfmpegProgress | undefined {
    const input = data.toString();

    if (input.indexOf('frame=') === 0) {
      try {
        const progress = new Map<string, string>();
        input.split(/\r?\n/).forEach((line) => {
          const split = line.split('=', 2);
          progress.set(split[0], split[1]);
        });

        return {
          frame: parseInt(progress.get('frame')!),
          fps: parseFloat(progress.get('fps')!),
          stream_q: parseFloat(progress.get('stream_0_0_q')!),
          bitrate: parseFloat(progress.get('bitrate')!),
          total_size: parseInt(progress.get('total_size')!),
          out_time_us: parseInt(progress.get('out_time_us')!),
          out_time: progress.get('out_time')!.trim(),
          dup_frames: parseInt(progress.get('dup_frames')!),
          drop_frames: parseInt(progress.get('drop_frames')!),
          speed: parseFloat(progress.get('speed')!),
          progress: progress.get('progress')!.trim(),
        };
      } catch {
        return undefined;
      }
    } else {
      return undefined;
    }
  }

  getStdin() {
    return this.process.stdin;
  }

  public stop(): void {
    this.process.stdin.write('q' + os.EOL);
    this.killTimeout = setTimeout(() => {
      this.process.kill('SIGKILL');
    }, 2 * 1000);
  }
}
