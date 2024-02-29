import {
  FirestoreDataConverter,
  QueryDocumentSnapshot,
  Timestamp,
} from "firebase-admin/firestore";
import {
  FirebaseSermon,
  Sermon,
  createEmptySermon,
  getDateString,
} from "./types";

export const firestoreAdminSermonConverter: FirestoreDataConverter<Sermon> = {
  toFirestore: (sermon: Sermon): FirebaseSermon => {
    return { ...sermon, date: Timestamp.fromMillis(sermon.dateMillis) };
  },
  fromFirestore: (snapshot: QueryDocumentSnapshot<FirebaseSermon>): Sermon => {
    const { date, ...data } = snapshot.data();
    const currentTime = Timestamp.now();
    return {
      ...createEmptySermon(),
      ...data,
      dateMillis: date?.toMillis() || currentTime.toMillis(),
      dateString: getDateString(date?.toDate() || currentTime.toDate()),
      id: snapshot.id,
    };
  },
};
