import path from 'path';
import { unlink } from 'fs/promises';
import { Bucket } from '@google-cloud/storage';
import { Sermon, sermonStatus, sermonStatusType } from './types';
import { Database } from 'firebase-admin/database';
import { DocumentReference, Firestore } from 'firebase-admin/firestore';
import { CustomMetadata, FilePaths, AudioSource } from './types';
import { CancelToken } from './CancelToken';
import { logMemoryUsage, secondsToTimeFormat, downloadFiles, getDurationSeconds, createTempFile } from './utils';
import trimAndTranscode from './trimAndTranscode';
import mergeFiles from './mergeFiles';
import { PROCESSED_SERMONS_BUCKET } from './consts';
import trim from './trim';
import { createLoggerWithContext } from './WinstonLogger';
import { LogContext, createChildContext, createContext } from './context';

export const processAudio = async (
  ytdlpPath: string,
  cancelToken: CancelToken,
  bucket: Bucket,
  realtimeDB: Database,
  db: Firestore,
  audioSource: AudioSource,
  docRef: DocumentReference<Sermon>,
  sermonStatus: sermonStatus,
  startTime: number,
  duration: number,
  deleteOriginal?: boolean,
  skipTranscode?: boolean,
  introUrl?: string,
  outroUrl?: string,
  ctx?: LogContext
): Promise<void> => {
  const fileName = audioSource.id;
  // Ensure sermonId is always set in context - use fileName (which is the sermonId) if not in ctx
  const contextWithSermonId = ctx ? { ...ctx } : createContext(fileName, 'process-audio');
  if (!contextWithSermonId.sermonId && fileName) {
    contextWithSermonId.sermonId = fileName;
  }
  const log = createLoggerWithContext(contextWithSermonId);
  const tempFiles = new Set<string>();

  log.info('Starting audio processing', {
    fileName,
    startTime,
    duration,
    sourceType: audioSource.type,
    skipTranscode: !!skipTranscode,
    hasIntro: !!introUrl,
    hasOutro: !!outroUrl,
  });

  await logMemoryUsage('Initial Memory Usage', contextWithSermonId);

  // Log Firestore connection details
  const isDevelopment = process.env.NODE_ENV === 'development';
  const firestoreEmulatorHost = process.env.FIRESTORE_EMULATOR_HOST;
  const documentPath = docRef.path;

  log.info('Attempting to access Firestore document', {
    documentPath,
    isDevelopment,
    firestoreEmulatorHost: firestoreEmulatorHost || 'production',
    firestoreUrl: firestoreEmulatorHost ? `http://${firestoreEmulatorHost}` : 'https://firestore.googleapis.com',
  });

  // the document may not exist yet, if it doesn't wait 5 seconds and try again do this for a max of 3 times before throwing an error
  const maxTries = 3;
  let currentTry = 0;
  let docFound = false;
  let title = 'untitled';
  while (currentTry < maxTries) {
    currentTry++;
    log.debug('Checking if document exists', {
      attempt: currentTry,
      maxTries,
      documentPath,
      firestoreEmulatorHost: firestoreEmulatorHost || 'production',
    });

    const doc = await docRef.get();

    if (doc.exists) {
      docFound = true;
      title = doc.data()?.title || 'No title found';
      log.info('Document found', { documentPath, title, attempt: currentTry });
      break;
    }

    if (currentTry < maxTries) {
      log.debug('No document exists, retrying', {
        attempt: currentTry,
        maxTries,
        documentPath,
        nextRetryIn: '5 seconds',
      });
      await new Promise((resolve) => setTimeout(resolve, 5000));
    }
  }

  if (!docFound) {
    log.error('Sermon document not found after retries', {
      fileName,
      attempts: maxTries,
      documentPath,
      firestoreEmulatorHost: firestoreEmulatorHost || 'production',
      firestoreUrl: firestoreEmulatorHost ? `http://${firestoreEmulatorHost}` : 'https://firestore.googleapis.com',
    });
    throw new Error(`Sermon Document ${fileName} Not Found at path: ${documentPath}`);
  }

  try {
    if (cancelToken.isCancellationRequested) return;
    await docRef.update({
      status: {
        ...sermonStatus,
        audioStatus: sermonStatusType.PROCESSING,
        message: 'Getting Data',
      },
    });
    const processedStoragePath = `${PROCESSED_SERMONS_BUCKET}/${fileName}`;
    const audioFilesToMerge: FilePaths = { INTRO: undefined, OUTRO: undefined };
    const customMetadata: CustomMetadata = { duration, title };
    if (introUrl) {
      audioFilesToMerge.INTRO = introUrl;
      customMetadata.introUrl = introUrl;
    }
    if (outroUrl) {
      audioFilesToMerge.OUTRO = outroUrl;
      customMetadata.outroUrl = outroUrl;
    }
    if (cancelToken.isCancellationRequested) return;

    const trimMessage = skipTranscode
      ? 'Trimming'
      : audioSource.type === 'StorageFilePath'
      ? 'Trimming and Transcoding'
      : 'Downloading YouTube Audio';

    log.info('Starting audio processing step', { step: trimMessage });

    await docRef.update({
      status: {
        ...sermonStatus,
        audioStatus: sermonStatusType.PROCESSING,
        message: trimMessage,
      },
    });

    // Ensure sermonId is always included in context
    // Ensure sermonId is preserved in child context
    const trimCtx = createChildContext(contextWithSermonId, 'trim');

    if (skipTranscode) {
      if (audioSource.type !== 'StorageFilePath') {
        log.error('Invalid audio source for skipTranscode', { sourceType: audioSource.type });
        throw new Error('Audio source must be a file from processed-sermons in order to trim without transcoding');
      }
      await trim(
        cancelToken,
        bucket,
        audioSource.source,
        processedStoragePath,
        tempFiles,
        realtimeDB.ref(`addIntroOutro/${fileName}`),
        customMetadata,
        startTime,
        duration,
        trimCtx
      );
    } else {
      await trimAndTranscode(
        ytdlpPath,
        cancelToken,
        bucket,
        audioSource,
        processedStoragePath,
        tempFiles,
        realtimeDB.ref(`addIntroOutro/${fileName}`),
        realtimeDB,
        docRef,
        sermonStatus,
        customMetadata,
        startTime,
        duration,
        trimCtx
      );
    }

    log.info('Audio processing step completed', { step: trimMessage });

    // download processed audio for merging
    const processedFilePath = createTempFile(`processed-${fileName}`, tempFiles);
    log.debug('Downloading processed audio and intro/outro files');
    const [tempFilePaths] = await Promise.all([
      downloadFiles(bucket, audioFilesToMerge, tempFiles),
      bucket.file(processedStoragePath).download({ destination: processedFilePath }),
    ]);

    //create merge array in order INTRO, CONTENT, OUTRO
    const filePathsArray: string[] = [];
    if (tempFilePaths.INTRO) filePathsArray.push(tempFilePaths.INTRO);
    filePathsArray.push(processedFilePath);
    if (tempFilePaths.OUTRO) filePathsArray.push(tempFilePaths.OUTRO);

    // use reduce to sum up all the durations of the files from filepaths
    const durationSeconds = (
      await Promise.all(
        [tempFilePaths.INTRO, tempFilePaths.OUTRO].map(async (path) => (path ? await getDurationSeconds(path) : 0))
      )
    ).reduce((accumulator, currentValue) => accumulator + currentValue, duration);

    customMetadata.duration = durationSeconds;
    log.info('Calculated total duration', { durationSeconds, formatted: secondsToTimeFormat(durationSeconds) });

    // if there is an intro or outro, merge the files
    if (filePathsArray.length > 1) {
      log.info('Merging files with intro/outro', { fileCount: filePathsArray.length });
      await docRef.update({
        status: {
          ...sermonStatus,
          audioStatus: sermonStatusType.PROCESSING,
          message: 'Adding Intro and Outro',
        },
      });
      const outputFilePath = `intro-outro-sermons/${path.basename(fileName)}`;

      // Ensure sermonId is preserved in child context
      const mergeCtx = createChildContext(contextWithSermonId, 'merge');
      const mergedOutputFile = await mergeFiles(
        cancelToken,
        bucket,
        filePathsArray,
        outputFilePath,
        durationSeconds,
        tempFiles,
        realtimeDB.ref(`addIntroOutro/${fileName}`),
        customMetadata,
        mergeCtx
      );
      log.info('Files merged successfully', { outputPath: mergedOutputFile.name });
      await logMemoryUsage('Memory Usage after merge', contextWithSermonId);
    } else {
      log.debug('No intro or outro, skipping merge');
    }

    if (cancelToken.isCancellationRequested) return;

    log.info('Updating status to PROCESSED');
    await docRef.update({
      status: {
        ...sermonStatus,
        audioStatus: sermonStatusType.PROCESSED,
      },
      durationSeconds: durationSeconds,
    });

    if (cancelToken.isCancellationRequested) return;
    realtimeDB.ref(`addIntroOutro/${fileName}`).set(100);

    // delete original audio file
    if (cancelToken.isCancellationRequested) return;
    if (audioSource.type === 'StorageFilePath') {
      const [originalFileExists] = await bucket.file(audioSource.source).exists();
      if (originalFileExists && deleteOriginal) {
        log.info('Deleting original audio file', { source: audioSource.source });
        await bucket.file(audioSource.source).delete();
      }
    }

    log.info('Audio processing completed successfully');
  } catch (error) {
    log.error('Audio processing failed', {
      error: error instanceof Error ? error.message : String(error),
      stack: error instanceof Error ? error.stack : undefined,
    });
    throw error;
  } finally {
    await realtimeDB.ref(`addIntroOutro/${fileName}`).remove();
    const promises: Promise<void>[] = [];
    tempFiles.forEach((file) => {
      promises.push(
        unlink(file).catch((err) => {
          log.warn('Failed to delete temp file', { file, error: err });
        })
      );
    });
    try {
      await Promise.all(promises);
      log.debug('Cleanup completed', { tempFilesDeleted: tempFiles.size });
    } catch (err) {
      log.error('Error during cleanup', { error: err });
    }
  }
};

// const addintrooutrotaskhandler = onTaskDispatched(
//   {
//     timeoutSeconds: TIMEOUT_SECONDS,
//     memory: "1GiB",
//     cpu: 1,
//     concurrency: 1,
//     retryConfig: {
//       maxAttempts: 2,
//       minBackoffSeconds: 10,
//     },
//   },
