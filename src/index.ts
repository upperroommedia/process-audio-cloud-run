import express, { Request } from 'express';
import {
  executeWithTimout,
  getAudioSource,
  loadStaticFFMPEG,
  logMemoryUsage,
  validateAddIntroOutroData,
} from './utils';
import { ProcessAudioInputType, sermonStatusType, uploadStatus, sermonStatus } from './types';
import { AxiosError, isAxiosError } from 'axios';
import { processAudio } from './processAudio';
import { CancelToken } from './CancelToken';
import { firestoreAdminSermonConverter } from './firestoreAdminDataConverter';
import { TIMEOUT_SECONDS } from './consts';
import firebaseAdmin from './firebaseAdmin';
import { LoggingWinston } from '@google-cloud/logging-winston';
import winston from 'winston';

const app = express();
app.use(express.json());
// get the path to the yt-dlp binary
const ytdlpPath = 'yt-dlp';
const loggingWinston = new LoggingWinston();
const logger = winston.createLogger({
  level: 'info',
  transports: [
    new winston.transports.Console(),
    // Add Cloud Logging
    loggingWinston,
  ],
});
logger.info('ytdlpPath', ytdlpPath);

logger.info('Loading storage, realtimeDB and firestore');
const bucket = firebaseAdmin.storage().bucket();
const realtimeDB = firebaseAdmin.database();
const db = firebaseAdmin.firestore();

logger.info('Loading ffmpeg');
const ffmpeg = loadStaticFFMPEG();

app.get('/', (req, res) => {
  const VERSION = '1.1.0';
  logger.info('GET /', `Process Audio Running version ${VERSION}`);
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
  // set timeout to 30 seconds less than timeoutSeconds then throw error if it takes longer than that
  logger.info('POST /process-audio', request.body);

  const data = request.body?.data;

  // data checks
  if (!data || !validateAddIntroOutroData(data)) {
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
    await executeWithTimout(
      () =>
        processAudio(
          ffmpeg,
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
          data.outroUrl
        ),
      cancelToken.cancel,
      timeoutMillis
    );
    res.status(200).send();
  } catch (e) {
    let message = 'Something Went Wrong';
    if (e instanceof Error) {
      message = e.message;
    } else if (isAxiosError(e)) {
      const axiosError = e as AxiosError;
      message = axiosError.message;
    } else if (e instanceof Error) {
      message = e.message;
    }
    try {
      logger.info('Updating audioStatus to ERROR');
      await docRef.update({
        status: {
          ...sermonStatus,
          audioStatus: sermonStatusType.ERROR,
          message: message,
        },
      });
    } catch (_e) {
      logger.error('Error Updating Document with docRef', docRef.path);
    }
    logger.error('Error', e);
    res.status(500).send(message);
  } finally {
    await logMemoryUsage('Final Memory Usage:');
  }
});

const port = parseInt(process.env.PORT ?? '') || 8080;
app.listen(port, () => {
  logger.info(`Process Audio Service running on port: ${port}`);
});
