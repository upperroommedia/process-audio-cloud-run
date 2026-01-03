import { Reference } from 'firebase-admin/database';
import { CancelToken } from './CancelToken';
import { Bucket, File } from '@google-cloud/storage';
import { CustomMetadata } from './types';
import { convertStringToMilliseconds, createTempFile, getFFmpegPath } from './utils';
import { writeFileSync } from 'fs';
import { spawn } from 'child_process';
import { createLoggerWithContext } from './WinstonLogger';
import { LogContext } from './context';

// Parse ffmpeg stderr for progress
function parseFFmpegProgress(stderrLine: string): { time?: string } {
  const result: { time?: string } = {};
  
  // Parse time: time=00:01:23.45
  const timeMatch = stderrLine.match(/time=(\d{2}:\d{2}:\d{2}\.\d{2})/);
  if (timeMatch) {
    result.time = timeMatch[1];
  }
  
  return result;
}

const mergeFiles = async (
  cancelToken: CancelToken,
  bucket: Bucket,
  filePaths: string[],
  outputFilePath: string,
  durationSeconds: number,
  tempFiles: Set<string>,
  realtimeDBref: Reference,
  customMetadata: CustomMetadata,
  ctx?: LogContext
): Promise<File> => {
  const log = createLoggerWithContext(ctx);
  
  log.info('Starting file merge', { fileCount: filePaths.length, outputPath: outputFilePath });
  
  const listFileName = createTempFile('list.txt', tempFiles);
  const outputFile = bucket.file(outputFilePath);
  const contentDisposition = customMetadata.title
    ? `inline; filename="${customMetadata.title}.mp3"`
    : 'inline; filename="untitled.mp3"';
  const writeStream = outputFile.createWriteStream({
    contentType: 'audio/mpeg',
    metadata: { contentDisposition, metadata: customMetadata },
  });

  // ffmpeg -f concat -i mylist.txt -c copy output
  const filePathsForTxt = filePaths.map((filePath) => `file '${filePath}'`);
  const fileNames = filePathsForTxt.join('\n');

  writeFileSync(listFileName, fileNames);

  // Build ffmpeg command
  const ffmpegPath = getFFmpegPath();
  const args = [
    '-f', 'concat',
    '-safe', '0',
    '-i', listFileName,
    '-c', 'copy',
    '-f', 'mp3',
    'pipe:1'
  ];
  
  const commandLine = `${ffmpegPath} ${args.join(' ')}`;
  log.info('FFmpeg command', { command: commandLine });
  
  const proc = spawn(ffmpegPath, args, {
    stdio: ['ignore', 'pipe', 'pipe']
  });
  
  if (!proc.stdout) {
    throw new Error('FFmpeg stdout is null');
  }
  proc.stdout.pipe(writeStream);
  
  if (!proc.stderr) {
    throw new Error('FFmpeg stderr is null');
  }
  
  let previousScaledPercent = -1;
  
  return new Promise((resolve, reject) => {
    realtimeDBref.set(98);
    
    proc.on('error', (err) => {
      log.error('FFmpeg spawn error', { error: err });
      reject(err);
    });
    
    proc.on('close', (code, signal) => {
      if (code === 0) {
        log.info('Merge completed successfully');
        realtimeDBref.set(98);
        resolve(outputFile);
      } else {
        log.error('FFmpeg process failed', { exitCode: code, signal });
        reject(new Error(`FFmpeg process exited with code ${code}`));
      }
    });
    
    proc.stderr.on('data', (data: Buffer) => {
      const stderrLine = data.toString();
      
      if (cancelToken.isCancellationRequested) {
        log.warn('Cancellation requested, terminating process');
        proc.kill('SIGTERM');
        reject(new Error('Merge operation was cancelled'));
        return;
      }
      
      const progress = parseFFmpegProgress(stderrLine);
      if (progress.time) {
        const timeMillis = convertStringToMilliseconds(progress.time);
        const durationMillis = durationSeconds * 1000;
        const percent = Math.round(Math.max(0, (timeMillis / durationMillis) * 100));
        // percent is a number between 0 - 100 but we want to scale it to be from 95 - 100
        const scaledPercent = Math.round(percent * 0.05 + 95);
        // Update progress whenever it changes to ensure smooth updates
        if (scaledPercent !== previousScaledPercent) {
          previousScaledPercent = scaledPercent;
          // Always log progress at info level so it's written in production
          log.info('Merge progress', { percent: scaledPercent });
          // Always update progress in DB regardless of log level - this is critical
          realtimeDBref.set(scaledPercent).catch((err) => {
            log.error('Failed to update progress in realtimeDB', { 
              error: err instanceof Error ? err.message : String(err),
              percent: scaledPercent 
            });
          });
        }
      }
    });
  });
};

export default mergeFiles;
