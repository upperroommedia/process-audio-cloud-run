import { Timestamp } from "firebase-admin/firestore";
import { v4 as uuidv4 } from "uuid";

type BaseProcessAudioInputType = {
  id: string;
  startTime: number;
  duration: number;
  deleteOriginal?: boolean;
  skipTranscode?: boolean;
  introUrl?: string;
  outroUrl?: string;
};

export type ProcessAudioInputType =
  | (BaseProcessAudioInputType & { storageFilePath: string })
  | (BaseProcessAudioInputType & { youtubeUrl: string });

export type FilePaths = {
  INTRO?: string;
  OUTRO?: string;
};

export type AudioSource =
  | {
      source: YouTubeUrl;
      id: string;
      type: "YouTubeUrl";
    }
  | {
      source: string;
      id: string;
      type: "StorageFilePath";
    };

export type CustomMetadata = {
  duration: number;
  title?: string;
  introUrl?: string;
  outroUrl?: string;
};

export type YouTubeUrl = string;

// Copied from web-app/types/Image.ts

export const ImageSizes = ["square", "wide", "banner"] as const;
export type ImageSizeType = (typeof ImageSizes)[number];
export type ImageType = {
  id: string;
  size: "thumbnail" | "small" | "medium" | "large" | "original" | "cropped";
  type: ImageSizeType;
  height: number;
  width: number;
  downloadLink: string;
  name: string;
  dateAddedMillis: number;
  subsplashId?: string;
  averageColorHex?: string;
  vibrantColorHex?: string;
};

// Copied from web-app/types/Speaker.ts

export interface ISpeaker {
  id: string;
  listId?: string;
  tagId?: string;
  name: string;
  images: ImageType[];
  sermonCount: number;
}

// Copied from web-app/types/SermonTypes.ts

export enum sermonStatusType {
  ERROR = "ERROR",
  PENDING = "PENDING",
  PROCESSING = "PROCESSING",
  PROCESSED = "PROCESSED",
}

export enum uploadStatus {
  ERROR = "ERROR",
  NOT_UPLOADED = "NOT_UPLOADED",
  UPLOADED = "UPLOADED",
}

export interface sermonStatus {
  subsplash: uploadStatus;
  soundCloud: uploadStatus;
  audioStatus: sermonStatusType;
  message?: string;
}

export interface Sermon {
  id: string;
  title: string;
  description: string;
  speakers: ISpeaker[];
  subtitle: string;
  dateMillis: number;
  sourceStartTime: number;
  durationSeconds: number;
  topics: string[];
  dateString?: string;
  status: sermonStatus;
  images: ImageType[];
  numberOfLists: number;
  numberOfListsUploadedTo: number;
  subsplashId?: string;
  soundCloudTrackId?: string;
  uploaderId?: string;
  approverId?: string;
  createdAtMillis: number;
  editedAtMillis: number;
  youtubeUrl?: string;
}

// Copied from web-app/types/Sermon.ts

export interface FirebaseSermon
  extends Omit<Sermon, "dateMillis" | "dateString"> {
  date: Timestamp;
}

export const getDateString = (date: Date) => {
  const months = [
    "Jan",
    "Feb",
    "Mar",
    "Apr",
    "May",
    "Jun",
    "Jul",
    "Aug",
    "Sep",
    "Oct",
    "Nov",
    "Dec",
  ];
  return `${months[date.getMonth()]} ${date.getDate()}`;
};

export const createEmptySermon = (uploaderId?: string): Sermon => {
  const currentDate = new Date();
  return {
    id: uuidv4(),
    title: "",
    subtitle: "",
    description: "",
    dateMillis: currentDate.getTime(),
    sourceStartTime: 0,
    durationSeconds: 0,
    speakers: [],
    topics: [],
    dateString: currentDate.toLocaleDateString(),
    status: {
      soundCloud: uploadStatus.NOT_UPLOADED,
      subsplash: uploadStatus.NOT_UPLOADED,
      audioStatus: sermonStatusType.PENDING,
    },
    images: [],
    ...(uploaderId && { uploaderId }),
    numberOfLists: 0,
    numberOfListsUploadedTo: 0,
    createdAtMillis: currentDate.getTime(),
    editedAtMillis: currentDate.getTime(),
  };
};
