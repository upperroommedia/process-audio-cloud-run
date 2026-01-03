import { CancelToken } from './CancelToken';
import path from 'path';
import { Bucket, File } from '@google-cloud/storage';
import { Reference } from 'firebase-admin/database';
import { convertStringToMilliseconds, createTempFile, logMemoryUsage, getFFmpegPath } from './utils';
import { CustomMetadata } from './types';
import { unlink } from 'fs/promises';
import { spawn } from 'child_process';
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
    stdio: ['ignore', 'pipe', 'pipe']
  });
  
  if (!proc.stdout) {
    throw new Error('FFmpeg stdout is null');
  }
  proc.stdout.pipe(writeStream);
  
  let totalTimeMillis: number | undefined;
  let previousPercent = -1;
  
  const promiseResult = await new Promise<File>((resolve, reject) => {
    proc.on('error', (err) => {
      log.error('FFmpeg spawn error', { error: err });
      reject(err);
    });
    
    proc.on('close', (code, signal) => {
      if (code === 0) {
        log.info('Trim completed successfully');
        resolve(outputFile);
      } else {
        log.error('FFmpeg process failed', { exitCode: code, signal });
        reject(new Error(`FFmpeg process exited with code ${code}`));
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

  // Delete raw audio from temp memory
  await logMemoryUsage('Before raw audio delete', ctx);
  log.debug('Deleting raw audio temp file', { file: rawSourceFile });
  await unlink(rawSourceFile);
  tempFiles.delete(rawSourceFile);
  await logMemoryUsage('After raw audio delete', ctx);

  return promiseResult;
};

export default trim;
