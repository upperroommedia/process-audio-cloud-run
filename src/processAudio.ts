import path from "path";
import { unlink } from "fs/promises";
import { Bucket } from "@google-cloud/storage";
import { Sermon, sermonStatus, sermonStatusType } from "./types";
import { Database } from "firebase-admin/database";
import { DocumentReference, Firestore } from "firebase-admin/firestore";
import { CustomMetadata, FilePaths, AudioSource } from "./types";
import { CancelToken } from "./CancelToken";
import { logMemoryUsage, secondsToTimeFormat, downloadFiles, getDurationSeconds, createTempFile } from "./utils";
import trimAndTranscode from "./trimAndTranscode";
import mergeFiles from "./mergeFiles";
import { PROCESSED_SERMONS_BUCKET } from "./consts";
import trim from "./trim";

export const processAudio = async (
  ffmpeg: typeof import("fluent-ffmpeg"),
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
  outroUrl?: string
): Promise<void> => {
  const fileName = audioSource.id;
  await logMemoryUsage("Initial Memory Usage:");
  const tempFiles = new Set<string>();
  // the document may not exist yet, if it deosnt wait 5 seconds and try again do this for a max of 3 times before throwing an error
  const maxTries = 3;
  let currentTry = 0;
  let docFound = false;
  let title = "untitled";
  while (currentTry < maxTries) {
    console.log(`Checking if document exists attempt: ${currentTry + 1}/${maxTries}`);
    const doc = await docRef.get();

    if (doc.exists) {
      docFound = true;
      title = doc.data()?.title || "No title found";
      break;
    }
    console.log(`No document exists attempt: ${currentTry + 1}/${maxTries}`);

    currentTry++;
    await new Promise((resolve) => setTimeout(resolve, 5000));
  }

  console.log("Out of while loop");
  if (!docFound) {
    throw new Error(`Sermon Document ${fileName} Not Found`);
  }

  try {
    if (cancelToken.isCancellationRequested) return;
    await docRef.update({
      status: {
        ...sermonStatus,
        audioStatus: sermonStatusType.PROCESSING,
        message: "Getting Data",
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
    console.log("Audio File Download Paths", JSON.stringify(audioFilesToMerge));
    if (cancelToken.isCancellationRequested) return;
    const trimMessage = skipTranscode
      ? "Trimming"
      : audioSource.type === "StorageFilePath"
      ? "Trimming and Transcoding"
      : "Downloading YouTube Audio";
    await docRef.update({
      status: {
        ...sermonStatus,
        audioStatus: sermonStatusType.PROCESSING,
        message: trimMessage,
      },
    });
    if (skipTranscode) {
      if (audioSource.type !== "StorageFilePath") {
        throw new Error("Audio source must be a file from processed-sermons in order to trim without transcoding");
      }
      await trim(
        ffmpeg,
        cancelToken,
        bucket,
        audioSource.source,
        processedStoragePath,
        tempFiles,
        realtimeDB.ref(`addIntroOutro/${fileName}`),
        customMetadata,
        startTime,
        duration
      );
    } else {
      await trimAndTranscode(
        ffmpeg,
        ytdlpPath,
        cancelToken,
        bucket,
        audioSource,
        processedStoragePath,
        tempFiles,
        realtimeDB.ref(`addIntroOutro/${fileName}`),
        docRef,
        sermonStatus,
        customMetadata,
        startTime,
        duration
      );
    }

    // download processed audio for merging
    const processedFilePath = createTempFile(`processed-${fileName}`, tempFiles);
    console.log("Downloading processed audio to", processedFilePath);
    const [tempFilePaths] = await Promise.all([
      await downloadFiles(bucket, audioFilesToMerge, tempFiles),
      await bucket.file(processedStoragePath).download({ destination: processedFilePath }),
    ]);
    console.log("Successfully downloaded processed audio");
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
    console.log("Total Duration", secondsToTimeFormat(durationSeconds));

    // if there is an intro or outro, merge the files
    if (filePathsArray.length > 1) {
      await docRef.update({
        status: {
          ...sermonStatus,
          audioStatus: sermonStatusType.PROCESSING,
          message: "Adding Intro and Outro",
        },
      });
      const outputFileName = `intro_outro-${fileName}`;
      const outputFilePath = `intro-outro-sermons/${path.basename(fileName)}`;
      //merge files
      console.log("Merging files", filePathsArray, "to", outputFileName, "...");
      const mergedOutputFile = await mergeFiles(
        ffmpeg,
        cancelToken,
        bucket,
        filePathsArray,
        outputFilePath,
        durationSeconds,
        tempFiles,
        realtimeDB.ref(`addIntroOutro/${fileName}`),
        customMetadata
      );
      console.log("MergedFiles saved to", mergedOutputFile.name);
      await logMemoryUsage("Memory Usage after merge:");
    } else {
      console.log("No intro or outro, skipping merge");
    }
    if (cancelToken.isCancellationRequested) return;
    console.log("Updating status to PROCESSED");
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
    if (audioSource.type === "StorageFilePath") {
      const [originalFileExists] = await bucket.file(audioSource.source).exists();
      if (originalFileExists && deleteOriginal) {
        console.log("Deleting original audio file", audioSource.source);
        await bucket.file(audioSource.source).delete();
        console.log("Original audio file deleted");
      }
    }

    console.log("Files have been merged succesfully");
  } catch (error) {
    throw error;
  } finally {
    await realtimeDB.ref(`addIntroOutro/${fileName}`).remove();
    const promises: Promise<void>[] = [];
    tempFiles.forEach((file) => {
      console.log("Deleting temp file", file);
      promises.push(unlink(file));
    });
    try {
      await Promise.all(promises);
      console.log("All temp files deleted");
    } catch (err) {
      console.error("Error when deleting temporary files", err);
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
