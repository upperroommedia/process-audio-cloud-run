import { CancelToken } from './CancelToken';
import { Bucket, File } from '@google-cloud/storage';
import { Database, Reference } from 'firebase-admin/database';
import {
  convertStringToMilliseconds,
  createTempFile,
  logMemoryUsage,
  throwErrorOnSpecificStderr,
  getFFmpegPath,
} from './utils';
import { CustomMetadata, AudioSource } from './types';
import { processYouTubeUrl } from './processYouTubeUrl';
import { unlink } from 'fs/promises';
import { PassThrough, Readable } from 'stream';
import { ChildProcessWithoutNullStreams, spawn } from 'child_process';
import { sermonStatus, sermonStatusType } from './types';
import { createLoggerWithContext } from './WinstonLogger';
import { LogContext } from './context';

// Parse ffmpeg stderr for progress and duration
function parseFFmpegProgress(stderrLine: string): { time?: string; duration?: string } {
  const result: { time?: string; duration?: string } = {};

  // Parse time: time=00:01:23.45
  const timeMatch = stderrLine.match(/time=(\d{2}:\d{2}:\d{2}\.\d{2})/);
  if (timeMatch) {
    result.time = timeMatch[1];
  }

  // Parse duration: Duration: 00:05:30.12
  const durationMatch = stderrLine.match(/Duration:\s*(\d{2}:\d{2}:\d{2}\.\d{2})/);
  if (durationMatch) {
    result.duration = durationMatch[1];
  }

  return result;
}

const trimAndTranscode = async (
  ytdlpPath: string,
  cancelToken: CancelToken,
  bucket: Bucket,
  audioSource: AudioSource,
  outputFilePath: string,
  tempFiles: Set<string>,
  realtimeDBRef: Reference,
  realtimeDB: Database,
  docRef: FirebaseFirestore.DocumentReference,
  sermonStatus: sermonStatus,
  customMetadata: CustomMetadata,
  startTime?: number,
  duration?: number,
  ctx?: LogContext
): Promise<File> => {
  const log = createLoggerWithContext(ctx);
  const outputFile = bucket.file(outputFilePath);
  const contentDisposition = customMetadata.title
    ? `inline; filename="${customMetadata.title}.mp3"`
    : 'inline; filename="untitled.mp3"';
  const writeStream = outputFile.createWriteStream({
    contentType: 'audio/mpeg',
    metadata: { contentDisposition, metadata: customMetadata },
    timeout: 30 * 60 * 1000, // 30 minutes in milliseconds
  });
  let inputSource: string | Readable | undefined;
  let ytdlp: ChildProcessWithoutNullStreams | undefined;
  let proc: ReturnType<typeof spawn> | undefined;
  let transcodingStarted = false;

  log.info('Starting trim and transcode', {
    sourceType: audioSource.type,
    startTime,
    duration,
    outputPath: outputFilePath,
  });

  const updateDownloadProgress = (progress: number) => {
    if (!transcodingStarted) {
      log.debug('YouTube download progress', { progress });
      realtimeDBRef.set(progress);
    }
  };

  try {
    if (audioSource.type === 'YouTubeUrl') {
      log.info('Processing YouTube URL', { url: audioSource.source });
      // Process the audio source from YouTube
      const passThrough = new PassThrough();
      ytdlp = await processYouTubeUrl(
        ytdlpPath,
        audioSource.source,
        cancelToken,
        passThrough,
        updateDownloadProgress,
        realtimeDB,
        ctx
      );
      inputSource = passThrough;
    } else {
      // Process the audio source from storage
      const rawSourceFile = createTempFile(`raw-${audioSource.id}`, tempFiles);
      log.debug('Downloading raw audio source', { source: audioSource.source, destination: rawSourceFile });
      await bucket.file(audioSource.source).download({ destination: rawSourceFile });
      inputSource = rawSourceFile;
    }

    // Build ffmpeg command
    const ffmpegPath = getFFmpegPath();
    const args: string[] = [];

    // Input options
    if (typeof inputSource === 'string') {
      // File input
      if (startTime) {
        // For files, we can use input seeking (before -i) for efficiency
        args.push('-ss', startTime.toString());
      }
      args.push('-i', inputSource);
    } else {
      // Stream/pipe input - must use stdin
      args.push('-i', 'pipe:0');
    }

    // Output seeking for streams (after -i)
    if (startTime && typeof inputSource !== 'string') {
      args.push('-ss', startTime.toString());
    }

    // Duration
    if (duration) {
      args.push('-t', duration.toString());
    }

    // Audio codec and filters
    args.push(
      '-acodec',
      'libmp3lame',
      '-b:a',
      '128k',
      '-ac',
      '2',
      '-ar',
      '44100',
      '-af',
      'dynaudnorm=g=21:m=40:c=1:b=0,afftdn,pan=stereo|c0<c0+c1|c1<c0+c1,loudnorm=I=-16:LRA=11:TP=-1.5',
      '-f',
      'mp3'
    );

    // Output to pipe
    args.push('pipe:1');

    const commandLine = `${ffmpegPath} ${args.join(' ')}`;
    log.info('FFmpeg command', { command: commandLine });

    proc = spawn(ffmpegPath, args, {
      stdio: typeof inputSource === 'string' ? ['ignore', 'pipe', 'pipe'] : ['pipe', 'pipe', 'pipe'],
    });

    // Pipe input if it's a stream
    if (typeof inputSource !== 'string') {
      if (!proc || !proc.stdin) {
        throw new Error('FFmpeg process or stdin is null but input is a stream');
      }
      // Use end: false to prevent automatic closing when inputSource ends
      // This allows ffmpeg to control when stdin closes (important for seeking)
      inputSource.pipe(proc.stdin, { end: false });
      const procForErrorHandler = proc; // Capture for error handler

      // Handle EPIPE errors gracefully - they occur when ffmpeg closes stdin early (e.g., during seeking)
      proc.stdin.on('error', (err: NodeJS.ErrnoException) => {
        if (err.code === 'EPIPE') {
          log.debug('FFmpeg stdin closed (EPIPE) - this is normal when seeking or process completes', {
            code: err.code,
          });
          // Don't kill the process - EPIPE is expected when the reader closes the pipe
        } else {
          log.error('FFmpeg stdin error', { error: err, code: err.code });
          procForErrorHandler.kill('SIGTERM');
        }
      });

      inputSource.on('error', (err: NodeJS.ErrnoException) => {
        if (err.code === 'EPIPE') {
          log.debug('Input stream EPIPE - ffmpeg may have closed stdin', { code: err.code });
          // EPIPE is expected when the destination closes the pipe
        } else {
          log.error('Input stream error', { error: err, code: err.code });
          procForErrorHandler.kill('SIGTERM');
        }
      });
    }

    // Pipe output
    if (!proc.stdout) {
      throw new Error('FFmpeg stdout is null');
    }
    proc.stdout.pipe(writeStream);

    // Handle EPIPE on write stream (can occur if storage write fails or is cancelled)
    writeStream.on('error', (err: NodeJS.ErrnoException) => {
      if (err.code === 'EPIPE') {
        log.warn('Write stream EPIPE - storage may have closed connection', { code: err.code });
      } else {
        log.error('Write stream error', { error: err, code: err.code });
      }
      if (proc) {
        proc.kill('SIGTERM');
      }
    });

    proc.stdout.on('error', (err: NodeJS.ErrnoException) => {
      if (err.code === 'EPIPE') {
        log.debug('FFmpeg stdout EPIPE - write stream may have closed', { code: err.code });
      } else {
        log.error('FFmpeg stdout error', { error: err, code: err.code });
      }
    });

    let totalTimeMillis: number | undefined;
    let previousPercent = -1;

    if (!proc) {
      throw new Error('FFmpeg process not initialized');
    }

    // Capture proc in const for use in promise callbacks
    const ffmpegProc = proc;

    const promiseResult = await new Promise<File>((resolve, reject) => {
      ffmpegProc.on('error', (err) => {
        log.error('FFmpeg spawn error', { error: err });
        reject(err);
      });

      ffmpegProc.on('close', (code, signal) => {
        if (code === 0) {
          log.info('Trim and transcode completed successfully');
          if (ytdlp) {
            log.debug('Terminating yt-dlp process');
            ytdlp.kill('SIGTERM');
          }
          resolve(outputFile);
        } else {
          log.error('FFmpeg process failed', { exitCode: code, signal });
          reject(new Error(`FFmpeg process exited with code ${code}`));
        }
      });

      if (!ffmpegProc.stderr) {
        reject(new Error('FFmpeg stderr is null'));
        return;
      }

      ffmpegProc.stderr.on('data', async (data: Buffer) => {
        const stderrLine = data.toString();

        try {
          throwErrorOnSpecificStderr(stderrLine);
        } catch (err) {
          log.error('FFmpeg error detected in stderr', { stderrLine, error: err });
          ffmpegProc.kill('SIGTERM');
          reject(err);
          return;
        }

        // Parse progress and duration
        const progress = parseFFmpegProgress(stderrLine);

        if (progress.duration && !totalTimeMillis) {
          totalTimeMillis = convertStringToMilliseconds(progress.duration);
          log.info('Detected input duration', { duration: progress.duration, milliseconds: totalTimeMillis });
        }

        if (progress.time) {
          if (cancelToken.isCancellationRequested) {
            log.warn('Cancellation requested, terminating processes');
            ffmpegProc.kill('SIGTERM');
            if (ytdlp) {
              ytdlp.kill('SIGTERM');
            }
            reject(new Error('Trim and Transcode operation was cancelled'));
            return;
          }

          if (!transcodingStarted) {
            transcodingStarted = true;
            log.info('Transcoding started');
            await docRef
              .update({
                status: {
                  ...sermonStatus,
                  audioStatus: sermonStatusType.PROCESSING,
                  message: 'Trimming and Transcoding',
                },
              })
              .catch((err) => log.error('Failed to update document status', { error: err }));
          }

          if (totalTimeMillis) {
            const timeMillis = convertStringToMilliseconds(progress.time);
            const calculatedDuration = duration
              ? duration * 1000
              : startTime
              ? totalTimeMillis - startTime * 1000
              : totalTimeMillis;
            const percent = Math.round(Math.max(0, ((timeMillis * 0.95) / calculatedDuration) * 100));
            if (percent !== previousPercent && percent % 5 === 0) {
              // Only log every 5% to reduce noise
              previousPercent = percent;
              log.debug('Processing progress', { percent });
              realtimeDBRef.set(percent);
            }
          }
        }
      });
    });

    if (typeof inputSource === 'string') {
      // Delete raw audio from temp memory
      await logMemoryUsage('Before raw audio delete', ctx);
      log.debug('Deleting raw audio temp file', { file: inputSource });
      await unlink(inputSource);
      tempFiles.delete(inputSource);
      await logMemoryUsage('After raw audio delete', ctx);
    }

    return promiseResult;
  } catch (error) {
    log.error('Trim and transcode failed', {
      error: error instanceof Error ? error.message : String(error),
      stack: error instanceof Error ? error.stack : undefined,
    });

    // Cleanup: kill processes if they exist
    if (proc) {
      try {
        log.debug('Terminating FFmpeg process due to error');
        proc.kill('SIGTERM');
      } catch (killError) {
        log.warn('Failed to kill FFmpeg process', { error: killError });
      }
    }
    if (ytdlp) {
      try {
        log.debug('Terminating YouTube download process due to error');
        ytdlp.kill('SIGTERM');
      } catch (killError) {
        log.warn('Failed to kill yt-dlp process', { error: killError });
      }
    }

    // Cleanup: delete temp files
    if (inputSource && typeof inputSource === 'string') {
      try {
        await unlink(inputSource);
        tempFiles.delete(inputSource);
      } catch (unlinkError) {
        log.warn('Failed to delete temporary file during error cleanup', { file: inputSource, error: unlinkError });
      }
    }

    throw error; // Bubble up the error
  } finally {
    await logMemoryUsage('After trim and transcode', ctx);
  }
};

export default trimAndTranscode;
