import { CancelToken } from './CancelToken';
import path from 'path';
import { Bucket, File } from '@google-cloud/storage';
import { Reference } from 'firebase-admin/database';
import { convertStringToMilliseconds, createTempFile, logMemoryUsage, getFFmpegPath } from './utils';
import { CustomMetadata } from './types';
import { unlink } from 'fs/promises';
import { spawn } from 'child_process';
import { finished } from 'stream';
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

const trim = async (
  cancelToken: CancelToken,
  bucket: Bucket,
  storageFilePath: string,
  outputFilePath: string,
  tempFiles: Set<string>,
  realtimeDBRef: Reference,
  customMetadata: CustomMetadata,
  startTime?: number,
  duration?: number,
  ctx?: LogContext
): Promise<File> => {
  const log = createLoggerWithContext(ctx);

  log.info('Starting trim operation', { storageFilePath, startTime, duration, outputPath: outputFilePath });

  // Download the raw audio source from storage
  const rawSourceFile = createTempFile(`raw-${path.basename(storageFilePath)}`, tempFiles);
  log.debug('Downloading raw audio source', { source: storageFilePath, destination: rawSourceFile });
  await bucket.file(storageFilePath).download({ destination: rawSourceFile });

  const outputFile = bucket.file(outputFilePath);
  const contentDisposition = customMetadata.title
    ? `inline; filename="${customMetadata.title}.mp3"`
    : 'inline; filename="untitled.mp3"';
  const writeStream = outputFile.createWriteStream({
    contentType: 'audio/mpeg',
    metadata: { contentDisposition, metadata: customMetadata },
  });

  // Build ffmpeg command
  const ffmpegPath = getFFmpegPath();
  const args: string[] = [];

  // Input seeking for files (before -i)
  if (startTime) {
    args.push('-ss', startTime.toString());
  }

  args.push('-i', rawSourceFile);

  // Duration
  if (duration) {
    args.push('-t', duration.toString());
  }

  // Copy codec (no transcoding)
  args.push('-c', 'copy', '-f', 'mp3', 'pipe:1');

  const commandLine = `${ffmpegPath} ${args.join(' ')}`;
  log.info('FFmpeg command', { command: commandLine });

  const proc = spawn(ffmpegPath, args, {
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  if (!proc.stdout) {
    throw new Error('FFmpeg stdout is null');
  }
  proc.stdout.pipe(writeStream);

  let totalTimeMillis: number | undefined;
  let previousPercent = -1;

  // Use Node.js stream.finished() to properly wait for GCS upload completion
  const writeStreamDone = new Promise<void>((resolveWrite, rejectWrite) => {
    finished(writeStream, (err) => {
      if (err) {
        log.error('GCS write stream error', { error: err.message, code: (err as NodeJS.ErrnoException).code });
        rejectWrite(err);
      } else {
        log.debug('GCS write stream finished - upload complete');
        resolveWrite();
      }
    });
  });

  const promiseResult = await new Promise<File>((resolve, reject) => {
    proc.on('error', (err) => {
      log.error('FFmpeg spawn error', { error: err });
      reject(err);
    });

    proc.on('close', async (code, signal) => {
      log.debug('FFmpeg process closed', { exitCode: code, signal });

      if (code !== 0) {
        log.error('FFmpeg process failed', { exitCode: code, signal });
        // Catch writeStreamDone rejection to avoid unhandled promise rejection
        writeStreamDone.catch((writeErr) => {
          log.debug('Write stream also failed (expected if it caused FFmpeg termination)', {
            error: writeErr instanceof Error ? writeErr.message : String(writeErr),
          });
        });
        reject(new Error(`FFmpeg process exited with code ${code}`));
        return;
      }

      // FFmpeg succeeded - now wait for GCS upload to complete
      try {
        await writeStreamDone;
        log.info('Trim completed successfully', { outputPath: outputFilePath });
        resolve(outputFile);
      } catch (uploadErr) {
        log.error('GCS upload failed after FFmpeg completed', { error: uploadErr });
        reject(new Error(`GCS upload failed: ${uploadErr instanceof Error ? uploadErr.message : String(uploadErr)}`));
      }
    });

    if (!proc.stderr) {
      reject(new Error('FFmpeg stderr is null'));
      return;
    }

    proc.stderr.on('data', (data: Buffer) => {
      const stderrLine = data.toString();

      // Parse progress and duration
      const progress = parseFFmpegProgress(stderrLine);

      if (progress.duration && !totalTimeMillis) {
        totalTimeMillis = convertStringToMilliseconds(progress.duration);
        log.info('Detected input duration', { duration: progress.duration, milliseconds: totalTimeMillis });
      }

      if (progress.time) {
        if (cancelToken.isCancellationRequested) {
          log.warn('Cancellation requested, terminating process');
          proc.kill('SIGTERM');
          reject(new Error('Trim operation was cancelled'));
          return;
        }

        if (totalTimeMillis) {
          const timeMillis = convertStringToMilliseconds(progress.time);
          const calculatedDuration = duration
            ? duration * 1000
            : startTime
            ? totalTimeMillis - startTime * 1000
            : totalTimeMillis;

          // Guard against division by zero
          if (calculatedDuration && calculatedDuration > 0) {
            // Calculate percentage (0-100%) then scale to 0-90% range for trim phase
            // This ensures: trim 0-90%, merge 90-100% for continuous progress
            const rawPercent = (timeMillis / calculatedDuration) * 100;
            const percent = Math.round(Math.max(0, Math.min(90, rawPercent * 0.9)));
            // Always log progress (more frequent than DB updates)
            log.debug('Processing progress', { percent });
            // Only update DB when percent actually changes (less frequent than logs)
            if (percent > previousPercent) {
              previousPercent = percent;
              realtimeDBRef.set(percent).catch((err) => {
                log.error('Failed to update progress in realtimeDB', {
                  error: err instanceof Error ? err.message : String(err),
                  percent,
                });
              });
            } else if (percent < previousPercent) {
              // Log when we detect backwards progress but don't update DB
              log.debug('Skipping backwards progress update', {
                previousPercent,
                newPercent: percent,
                timeMillis,
              });
            }
            // If percent === previousPercent, we just log (already done above) but don't update DB
          } else {
            // Log time elapsed even if we can't calculate percentage (edge case)
            log.debug('Processing (cannot calculate percentage - invalid duration)', {
              timeMillis,
              calculatedDuration,
            });
          }
        }
      }
    });
  });

  // Delete raw audio from temp memory
  await logMemoryUsage('Before raw audio delete', ctx);
  log.debug('Deleting raw audio temp file', { file: rawSourceFile });
  await unlink(rawSourceFile);
  tempFiles.delete(rawSourceFile);
  await logMemoryUsage('After raw audio delete', ctx);

  return promiseResult;
};

export default trim;
