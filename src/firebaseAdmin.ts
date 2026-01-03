import firebaseAdmin from 'firebase-admin';
import { applicationDefault } from 'firebase-admin/app';
import logger from './WinstonLogger';
const isDevelopment = process.env.NODE_ENV === 'development';

if (!firebaseAdmin.apps.length) {
  if (isDevelopment) {
    logger.info('Setting Admin SDK to use emulator');
    // Use environment variables if set, otherwise default to localhost
    // For Docker, set these to host.docker.internal (Mac/Windows) or host IP (Linux)
    const emulatorHost = process.env.FIREBASE_EMULATOR_HOST || '127.0.0.1';
    const firestorePort = process.env.FIRESTORE_EMULATOR_PORT || '8080';
    const authPort = process.env.FIREBASE_AUTH_EMULATOR_PORT || '9099';
    const storagePort = process.env.FIREBASE_STORAGE_EMULATOR_PORT || '9199';
    const databasePort = process.env.FIREBASE_DATABASE_EMULATOR_PORT || '9000';

    const authHost = `${emulatorHost}:${authPort}`;
    const firestoreHost = `${emulatorHost}:${firestorePort}`;
    const storageHost = `${emulatorHost}:${storagePort}`;
    const databaseHost = `${emulatorHost}:${databasePort}`;

    process.env.FIREBASE_AUTH_EMULATOR_HOST = authHost;
    process.env.FIRESTORE_EMULATOR_HOST = firestoreHost;
    process.env.FIREBASE_STORAGE_EMULATOR_HOST = storageHost;
    process.env.FIREBASE_DATABASE_EMULATOR_HOST = databaseHost;

    logger.info('Emulator configuration', {
      emulatorHost,
      auth: {
        host: authHost,
        url: `http://${authHost}`,
      },
      firestore: {
        host: firestoreHost,
        url: `http://${firestoreHost}`,
      },
      storage: {
        host: storageHost,
        url: `http://${storageHost}`,
      },
      database: {
        host: databaseHost,
        url: `http://${databaseHost}`,
      },
    });
  } else {
    logger.info('Using production Firebase services', {
      storageBucket: 'urm-app.appspot.com',
      databaseURL: 'https://urm-app-default-rtdb.firebaseio.com/',
    });
  }

  // Configure databaseURL for emulator or production
  const databaseURL =
    isDevelopment && process.env.FIREBASE_DATABASE_EMULATOR_HOST
      ? `http://${process.env.FIREBASE_DATABASE_EMULATOR_HOST}?ns=urm-app-default-rtdb`
      : 'https://urm-app-default-rtdb.firebaseio.com/';

  if (isDevelopment) {
    logger.info('Database URL configured', { databaseURL });
  }

  // In development with emulators, we don't need real credentials
  // In production, we need real credentials
  const initConfig: {
    projectId: string;
    storageBucket: string;
    databaseURL: string;
    credential?: ReturnType<typeof applicationDefault>;
  } = {
    projectId: 'urm-app', // Required for emulators to work properly
    storageBucket: 'urm-app.appspot.com',
    databaseURL,
  };

  if (!isDevelopment) {
    // Only add credentials in production
    initConfig.credential = applicationDefault();
  }

  firebaseAdmin.initializeApp(initConfig);
}
export default firebaseAdmin;
