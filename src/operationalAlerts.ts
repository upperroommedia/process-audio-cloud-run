import { FieldValue } from 'firebase-admin/firestore';
import firebaseAdmin from './firebaseAdmin';
import { Sermon } from './types';
import logger from './WinstonLogger';

const MAIL_COLLECTION = 'mail';
const ALERT_SOURCE = 'process-audio-cloud-run';

type AlertUserDetails = {
  uid: string;
  email?: string;
  displayName?: string;
};

type RuntimeAlertInput = {
  alertCode: string;
  summary: string;
  error: unknown;
  context?: Record<string, unknown>;
  sermonId?: string;
};

const getRuntimeAlertRecipients = (): string[] => {
  const raw =
    process.env.PROCESS_AUDIO_ALERT_RECIPIENTS ||
    process.env.RUNTIME_ALERT_RECIPIENTS ||
    process.env.RUNTIME_ALERT_EMAILS ||
    '';

  const normalized = raw.trim();
  if (!normalized) {
    return [];
  }

  if (normalized.startsWith('[')) {
    try {
      const parsed = JSON.parse(normalized);
      if (Array.isArray(parsed)) {
        return parsed
          .map((value) => (typeof value === 'string' ? value.trim().toLowerCase() : ''))
          .filter(Boolean);
      }
    } catch {
      // Fall through to delimiter-based parsing for malformed JSON.
    }
  }

  return normalized
    .split(/[,\n;]/)
    .map((value) => value.trim().replace(/^['"]+|['"]+$/g, '').toLowerCase())
    .filter(Boolean);
};

const formatAlertDateTime = (timestampMs: number): string =>
  new Date(timestampMs).toLocaleString('en-US', {
    dateStyle: 'medium',
    timeStyle: 'short',
    timeZone: 'America/Los_Angeles',
  });

const getErrorPayload = (
  error: unknown
): { errorMessage: string; errorName?: string; errorStack?: string } => {
  if (error instanceof Error) {
    return {
      errorMessage: error.message,
      ...(error.name ? { errorName: error.name } : {}),
      ...(error.stack ? { errorStack: error.stack } : {}),
    };
  }

  if (typeof error === 'string') {
    return { errorMessage: error };
  }

  return { errorMessage: 'Unknown error' };
};

const escapeHtml = (value: string): string =>
  value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');

const buildDetailRows = (details: Array<{ label: string; value: string }>): string =>
  details
    .map(
      ({ label, value }) =>
        `<tr><td style="padding:6px 12px 6px 0;font-weight:600;vertical-align:top;">${escapeHtml(label)}</td><td style="padding:6px 0;white-space:pre-wrap;">${escapeHtml(value)}</td></tr>`
    )
    .join('');

const resolveAlertUser = async (uid?: string): Promise<AlertUserDetails | null> => {
  if (!uid) {
    return null;
  }

  try {
    const user = await firebaseAdmin.auth().getUser(uid);
    const displayName = typeof user.displayName === 'string' && user.displayName.trim().length > 0 ? user.displayName.trim() : undefined;
    const email = typeof user.email === 'string' && user.email.trim().length > 0 ? user.email.trim().toLowerCase() : undefined;
    return {
      uid,
      ...(email ? { email } : {}),
      ...(displayName ? { displayName } : {}),
    };
  } catch (error) {
    logger.warn('Failed to resolve operational alert user', {
      uid,
      error: error instanceof Error ? error.message : String(error),
    });
    return { uid };
  }
};

const resolveSermonContext = async (
  sermonId?: string
): Promise<{ sermon?: Sermon; uploader?: AlertUserDetails | null; approver?: AlertUserDetails | null }> => {
  if (!sermonId) {
    return {};
  }

  try {
    const snapshot = await firebaseAdmin.firestore().collection('sermons').doc(sermonId).get();
    if (!snapshot.exists) {
      return {};
    }

    const sermon = snapshot.data() as Sermon;
    const [uploader, approver] = await Promise.all([
      resolveAlertUser(sermon.uploaderId),
      resolveAlertUser(sermon.approverId),
    ]);

    return { sermon, uploader, approver };
  } catch (error) {
    logger.warn('Failed to resolve sermon context for operational alert', {
      sermonId,
      error: error instanceof Error ? error.message : String(error),
    });
    return {};
  }
};

const formatUser = (user: AlertUserDetails | null | undefined): string | null => {
  if (!user?.uid) {
    return null;
  }

  if (user.displayName && user.email) {
    return `${user.displayName} <${user.email}> (${user.uid})`;
  }

  if (user.email) {
    return `${user.email} (${user.uid})`;
  }

  if (user.displayName) {
    return `${user.displayName} (${user.uid})`;
  }

  return user.uid;
};

export const emitOperationalAlertEmail = async (input: RuntimeAlertInput): Promise<void> => {
  const recipients = getRuntimeAlertRecipients();
  if (recipients.length === 0) {
    logger.warn('Skipping operational alert email because no recipients are configured', {
      alertCode: input.alertCode,
    });
    return;
  }

  const occurredAtMs = Date.now();
  const errorPayload = getErrorPayload(input.error);
  const { sermon, uploader, approver } = await resolveSermonContext(input.sermonId);

  const details: Array<{ label: string; value: string }> = [
    { label: 'Alert code', value: input.alertCode },
    { label: 'Occurred at', value: formatAlertDateTime(occurredAtMs) },
    { label: 'Error message', value: errorPayload.errorMessage },
    ...(errorPayload.errorName ? [{ label: 'Error name', value: errorPayload.errorName }] : []),
    ...(input.sermonId ? [{ label: 'Sermon ID', value: input.sermonId }] : []),
    ...(sermon?.title ? [{ label: 'Sermon title', value: sermon.title }] : []),
    ...(formatUser(uploader) ? [{ label: 'Triggered by uploader', value: formatUser(uploader) as string }] : []),
    ...(formatUser(approver) ? [{ label: 'Approver', value: formatUser(approver) as string }] : []),
    ...(input.context ? [{ label: 'Context', value: JSON.stringify(input.context, null, 2) }] : []),
    ...(errorPayload.errorStack ? [{ label: 'Error stack', value: errorPayload.errorStack }] : []),
  ];

  const text = [
    'UpperRoom Media process-audio runtime alert',
    '',
    `Summary: ${input.summary}`,
    ...details.map(({ label, value }) => `${label}: ${value}`),
  ].join('\n');

  const html = `
    <div style="font-family:Arial,sans-serif;line-height:1.5;color:#111827;">
      <h2 style="margin:0 0 16px;">Process-audio runtime alert</h2>
      <p style="margin:0 0 16px;">${escapeHtml(input.summary)}</p>
      <table style="border-collapse:collapse;">${buildDetailRows(details)}</table>
    </div>
  `;

  await firebaseAdmin.firestore().collection(MAIL_COLLECTION).add({
    to: recipients,
    message: {
      subject: `[URM] Process-audio alert: ${input.alertCode}`,
      text,
      html,
    },
    meta: {
      source: ALERT_SOURCE,
      alertType: 'runtime-error',
      alertCode: input.alertCode,
      sermonId: input.sermonId ?? null,
    },
    createdAt: FieldValue.serverTimestamp(),
  });

  logger.error('Operational alert email queued', {
    alertCode: input.alertCode,
    recipientCount: recipients.length,
    sermonId: input.sermonId ?? null,
    uploaderEmail: uploader?.email ?? null,
  });
};
