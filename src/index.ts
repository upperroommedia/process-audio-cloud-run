import express, { Request } from 'express';
import { executeWithTimeout, getAudioSource, getFFmpegPath, logMemoryUsage, validateAddIntroOutroData } from './utils';
import { ProcessAudioInputType, sermonStatusType, uploadStatus, sermonStatus } from './types';
import { AxiosError, isAxiosError } from 'axios';
import { processAudio } from './processAudio';
import { CancelToken } from './CancelToken';
import { firestoreAdminSermonConverter } from './firestoreAdminDataConverter';
import { TIMEOUT_SECONDS } from './consts';
import firebaseAdmin from './firebaseAdmin';
import logger, { createLoggerWithContext } from './WinstonLogger';
import { createContext } from './context';

const app = express();
app.use(express.json());
// get the path to the yt-dlp binary
const ytdlpPath = 'yt-dlp';

logger.info('Service initializing', { ytdlpPath });

logger.info('Loading storage, realtimeDB and firestore');
const bucket = firebaseAdmin.storage().bucket();
const realtimeDB = firebaseAdmin.database();
const db = firebaseAdmin.firestore();

// Log Firestore connection details after initialization
const isDevelopment = process.env.NODE_ENV === 'development';
if (isDevelopment) {
  const firestoreEmulatorHost = process.env.FIRESTORE_EMULATOR_HOST;
  logger.info('Firestore initialized', {
    isDevelopment,
    firestoreEmulatorHost: firestoreEmulatorHost || 'not set (using production)',
    firestoreUrl: firestoreEmulatorHost ? `http://${firestoreEmulatorHost}` : 'https://firestore.googleapis.com',
  });

  // Test Firestore connection asynchronously (non-blocking)
  (async () => {
    try {
      const testRef = db.collection('_test_connection').doc('_test');
      await testRef.set({ test: true, timestamp: Date.now() });
      await testRef.delete();
      logger.info('Firestore emulator connection test successful');
    } catch (error) {
      logger.error('Firestore emulator connection test failed', {
        error: error instanceof Error ? error.message : String(error),
        firestoreEmulatorHost,
        hint: 'Make sure the emulator is running on 0.0.0.0 (not 127.0.0.1) and accessible from Docker',
      });
    }
  })();
}

logger.info('Initializing ffmpeg');
getFFmpegPath(); // Initialize and verify ffmpeg is available
logger.info('Service ready');

app.get('/', (req, res) => {
  const VERSION = '1.1.0';
  res.send(`
  Process Audio Running version ${VERSION}
  Post to /process-audio with data in the format of
  {
    id (string),
    startTime (number),
    duration (number),
    youtubeUrl (string) || storageFilePath (string),
    introUrl (string),
    outroUrl (string)
  }
  `);
});

app.post('/process-audio', async (request: Request<{}, {}, { data: ProcessAudioInputType }>, res) => {
  const timeoutMillis = (TIMEOUT_SECONDS - 30) * 1000; // 30s less than timeoutSeconds
  const data = request.body?.data;

  // Create context for this request - ensure sermonId is always set
  const sermonId = data?.id;
  const ctx = createContext(sermonId, 'process-audio');
  // Ensure sermonId is set even if data.id was undefined (fallback to empty string to maintain context structure)
  if (!ctx.sermonId && sermonId) {
    ctx.sermonId = sermonId;
  }
  const log = createLoggerWithContext(ctx);

  log.info('Request received', {
    hasData: !!data,
    sourceType: 'youtubeUrl' in (data || {}) ? 'youtube' : 'storageFilePath' in (data || {}) ? 'storage' : 'unknown',
  });

  // data checks
  if (!data || !validateAddIntroOutroData(data)) {
    log.warn('Invalid request data');
    res.status(400).send(
      `Invalid body: body must be an object with the following field: 
         id (string),
         startTime (number),
         duration (number),
         youtubeUrl (string) || storageFilePath (string),
         introUrl (string),
         outroUrl (string)`
    );
    return;
  }

  const audioSource = getAudioSource(data);
  const docRef = db.collection('sermons').withConverter(firestoreAdminSermonConverter).doc(data.id);
  const sermonStatus: sermonStatus = {
    subsplash: uploadStatus.NOT_UPLOADED,
    soundCloud: uploadStatus.NOT_UPLOADED,
    audioStatus: sermonStatusType.PROCESSING,
  };

  try {
    const cancelToken = new CancelToken();
    await executeWithTimeout(
      () =>
        processAudio(
          ytdlpPath,
          cancelToken,
          bucket,
          realtimeDB,
          db,
          audioSource,
          docRef,
          sermonStatus,
          data.startTime,
          data.duration,
          data.deleteOriginal,
          data.skipTranscode,
          data.introUrl,
          data.outroUrl,
          ctx
        ),
      cancelToken.cancel,
      timeoutMillis
    );
    log.info('Request completed successfully');
    res.status(200).send();
  } catch (e) {
    let message = 'Something Went Wrong';
    if (e instanceof Error) {
      message = e.message;
    } else if (isAxiosError(e)) {
      const axiosError = e as AxiosError;
      message = axiosError.message;
    }

    log.error('Request failed', {
      error: message,
      errorType: e?.constructor?.name,
      stack: e instanceof Error ? e.stack : undefined,
    });

    try {
      await docRef.update({
        status: {
          ...sermonStatus,
          audioStatus: sermonStatusType.ERROR,
          message: message,
        },
      });
    } catch (updateError) {
      log.error('Failed to update document status', { error: updateError });
    }
    res.status(500).send(message);
  } finally {
    await logMemoryUsage('Final Memory Usage', ctx);
  }
});

const port = parseInt(process.env.PORT ?? '') || 8080;
app.listen(port, () => {
  logger.info('Service started', { port });
});
