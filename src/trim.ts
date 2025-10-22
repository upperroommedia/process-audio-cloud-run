import { CancelToken } from './CancelToken';
import path from 'path';
import { Bucket, File } from '@google-cloud/storage';
import { Reference } from 'firebase-admin/database';
import { convertStringToMilliseconds, createTempFile, logMemoryUsage } from './utils';
import { CustomMetadata } from './types';
import { unlink } from 'fs/promises';
import logger from './WinstonLogger';

const trimAndTranscode = async (
  ffmpeg: typeof import('fluent-ffmpeg'),
  cancelToken: CancelToken,
  bucket: Bucket,
  storageFilePath: string,
  outputFilePath: string,
  tempFiles: Set<string>,
  realtimeDBRef: Reference,
  customMetadata: CustomMetadata,
  startTime?: number,
  duration?: number
): Promise<File> => {
  // Download the raw audio source from storage
  logger.info('Trimming but not transcoding audio source:', storageFilePath);
  const rawSourceFile = createTempFile(`raw-${path.basename(storageFilePath)}`, tempFiles);
  logger.info('Downloading raw audio source to', rawSourceFile);
  await bucket.file(storageFilePath).download({ destination: rawSourceFile });
  logger.info('Successfully downloaded raw audio source');

  const outputFile = bucket.file(outputFilePath);
  const contentDisposition = customMetadata.title
    ? `inline; filename="${customMetadata.title}.mp3"`
    : 'inline; filename="untitled.mp3"';
  const writeStream = outputFile.createWriteStream({
    contentType: 'audio/mpeg',
    metadata: { contentDisposition, metadata: customMetadata },
  });
  const proc = ffmpeg().input(rawSourceFile).format('mp3');
  if (startTime) proc.setStartTime(startTime);
  if (duration) proc.setDuration(duration);
  proc.outputOption('-c copy');
  let totalTimeMillis: number;
  let previousPercent = -1;
  const promiseResult = await new Promise<File>((resolve, reject) => {
    proc
      .on('start', function (commandLine) {
        logger.info('Trim Spawned Ffmpeg with command: ' + commandLine);
      })
      .on('end', async () => {
        logger.info('Finished Trim');
        resolve(outputFile);
      })
      .on('error', (err, stdout, stderr) => {
        logger.error('Trim Error:', err);
        logger.error('ffmpeg stdout:', stdout);
        logger.error('ffmpeg stderr:', stderr);
        reject(err);
      })
      .on('codecData', (data) => {
        // HERE YOU GET THE TOTAL TIME
        logger.info('Total duration: ' + data.duration);
        totalTimeMillis = convertStringToMilliseconds(data.duration);
      })
      .on('progress', async (progress) => {
        if (cancelToken.isCancellationRequested) {
          logger.info('Cancellation requested, killing ffmpeg process');
          proc.kill('SIGTERM'); // this sends a termination signal to the process
          reject(new Error('Trim operation was cancelled'));
        }
        const timeMillis = convertStringToMilliseconds(progress.timemark);
        const calculatedDuration = duration
          ? duration * 1000
          : startTime
          ? totalTimeMillis - startTime * 1000
          : totalTimeMillis;
        const percent = Math.round(Math.max(0, ((timeMillis * 0.95) / calculatedDuration) * 100)); // go to 95% to leave room for the time it takes to Merge the files
        if (percent !== previousPercent) {
          previousPercent = percent;
          logger.info('Trim Progress:', percent);
          realtimeDBRef.set(percent);
        }
      })
      .pipe(writeStream);
  });

  // Delete raw audio from temp memory
  await logMemoryUsage('Before raw audio delete memory');
  logger.info('Deleting raw audio temp file:', rawSourceFile);
  await unlink(rawSourceFile);
  tempFiles.delete(rawSourceFile);
  logger.info('Successfully deleted raw audio temp file:', rawSourceFile);
  await logMemoryUsage('After raw audio delete memory');

  return promiseResult;
};

export default trimAndTranscode;
