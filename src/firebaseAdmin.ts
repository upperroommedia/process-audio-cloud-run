import firebaseAdmin from 'firebase-admin';
import { applicationDefault } from 'firebase-admin/app';
import { logger } from './index';
const isDevelopment = process.env.NODE_ENV === 'development';

if (!firebaseAdmin.apps.length) {
  if (isDevelopment) {
    logger.info('Setting Admin SDK to use emulator');
    process.env.FIREBASE_AUTH_EMULATOR_HOST = '127.0.0.1:9099';
  }

  firebaseAdmin.initializeApp({
    credential: applicationDefault(),
    storageBucket: 'urm-app.appspot.com',
    databaseURL: 'https://urm-app-default-rtdb.firebaseio.com/',
  });
}
export default firebaseAdmin;
