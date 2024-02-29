import express, { Request } from "express";
import path from "path";
import {
  executeWithTimout,
  getAudioSource,
  loadStaticFFMPEG,
  logMemoryUsage,
  validateAddIntroOutroData,
} from "./utils";
import {
  ProcessAudioInputType,
  sermonStatusType,
  uploadStatus,
  sermonStatus,
} from "./types";
import { AxiosError, isAxiosError } from "axios";
import { processAudio } from "./processAudio";
import { CancelToken } from "./CancelToken";
import { firestoreAdminSermonConverter } from "./firestoreAdminDataConverter";
import { TIMEOUT_SECONDS } from "./consts";
import firebaseAdmin from "./firebaseAdmin";

const app = express();
app.use(express.json());
// get the path to the yt-dlp binary
const ytdlpPath = path.join(__dirname, "../bin", "yt-dlp");
console.log("ytdlpPath", ytdlpPath);

console.log("Loading storage, realtimeDB and firestore");
const bucket = firebaseAdmin.storage().bucket();
const realtimeDB = firebaseAdmin.database();
const db = firebaseAdmin.firestore();

console.log("Loading ffmpeg");
const ffmpeg = loadStaticFFMPEG();

app.get("/", (req, res) => {
  console.log("GET /", "Process Audio Running version 1.0.0");
  res.send(`
  Process Audio Running version 1.0.0
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

app.post(
  "/process-audio",
  async (request: Request<{}, {}, ProcessAudioInputType>, res) => {
    const timeoutMillis = (TIMEOUT_SECONDS - 30) * 1000; // 30s less than timeoutSeconds
    // set timeout to 30 seconds less than timeoutSeconds then throw error if it takes longer than that
    const data = request.body;
    console.log("POST /process-audio", data);

    // data checks
    if (!validateAddIntroOutroData(data)) {
      res.status(400).send(
        `Invalid body: boyd must be an object with the following field: 
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
    const docRef = db
      .collection("sermons")
      .withConverter(firestoreAdminSermonConverter)
      .doc(data.id);
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
      let message = "Something Went Wrong";
      if (e instanceof Error) {
        message = e.message;
      } else if (isAxiosError(e)) {
        const axiosError = e as AxiosError;
        message = axiosError.message;
      } else if (e instanceof Error) {
        message = e.message;
      }
      try {
        await docRef.update({
          status: {
            ...sermonStatus,
            audioStatus: sermonStatusType.ERROR,
            message: message,
          },
        });
      } catch (_e) {
        console.error("Error Updating Document with docRef", docRef.path);
      }
      console.error("Error", e);
      res.status(500).send(message);
    } finally {
      await logMemoryUsage("Final Memory Usage:");
    }
  }
);

const port = parseInt(process.env.PORT ?? "") || 8080;
app.listen(port, () => {
  console.log(`Youtube Speed Test: listening on port ${port}`);
});
