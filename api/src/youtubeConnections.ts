import { createCipheriv, createDecipheriv, randomBytes, randomUUID } from 'node:crypto';
import { FieldValue, Firestore } from '@google-cloud/firestore';
import { GoogleAuth, OAuth2Client, type Credentials } from 'google-auth-library';
import type { Config } from './config.js';

const scopes = [
  'https://www.googleapis.com/auth/youtube.readonly',
  'https://www.googleapis.com/auth/yt-analytics.readonly',
];

export type YouTubeConnectionStatus = {
  configured: boolean;
  connected: boolean;
  channelId?: string;
  connectedAt?: string;
  lastSyncedAt?: string;
  syncState?: 'idle' | 'running' | 'complete' | 'failed';
  syncActivity?: Array<{ createdAt: string; message: string }>;
  lastSyncError?: string;
  syncRunId?: string;
  syncStartedAt?: string;
  syncStage?: string;
  syncProgress?: { current: number; total: number };
};

export interface YouTubeConnections {
  status(ownerId: string): Promise<YouTubeConnectionStatus>;
  begin(ownerId: string): Promise<string>;
  finish(state: string, code: string): Promise<void>;
  sync(ownerId: string): Promise<{ started: boolean }>;
  disconnect(ownerId: string): Promise<void>;
  successUrl(outcome: 'connected' | 'error'): string;
}

export class DisabledYouTubeConnections implements YouTubeConnections {
  constructor(private readonly config: Config) {}
  async status(): Promise<YouTubeConnectionStatus> { return { configured: false, connected: false }; }
  async begin(): Promise<string> { throw new Error('YouTube OAuth is not configured'); }
  async finish(): Promise<void> { throw new Error('YouTube OAuth is not configured'); }
  async sync(): Promise<never> { throw new Error('YouTube OAuth is not configured'); }
  async disconnect(): Promise<void> {}
  successUrl(outcome: 'connected' | 'error') { return withOutcome(this.config.YOUTUBE_OAUTH_SUCCESS_URL || `${this.config.CORS_ORIGIN}/studio/`, outcome); }
}

type ConnectionDocument = {
  ownerId?: string;
  encryptedCredentials: string;
  connectedAt: string;
  channelId?: string;
  lastSyncedAt?: string;
  syncState?: 'idle' | 'running' | 'complete' | 'failed';
  syncActivity?: Array<{ createdAt: string; message: string }>;
  lastSyncError?: string;
  currentSyncRunId?: string;
  syncStartedAt?: string;
  syncStage?: string;
  syncProgress?: { current: number; total: number };
};

type SyncProgress = { stage: string; current?: number; total?: number };

const progressFromMessage = (message: string): SyncProgress => {
  const report = message.match(/retention report (\d+) of (\d+)/i);
  if (report) return { stage: 'reading_retention', current: Number(report[1]), total: Number(report[2]) };
  const stored = message.match(/stored (?:history|retention) (\d+) of (\d+)/i);
  if (stored) return { stage: 'storing_retention', current: Number(stored[1]), total: Number(stored[2]) };
  if (/accepted/i.test(message)) return { stage: 'worker_started' };
  if (/authorized youtube channel/i.test(message)) return { stage: 'channel_authorized' };
  if (/found .* videos/i.test(message)) return { stage: 'videos_discovered' };
  return { stage: 'running' };
};

export class FirestoreYouTubeConnections implements YouTubeConnections {
  private readonly db: Firestore;
  private readonly key: Buffer;

  constructor(private readonly config: Config) {
    this.db = new Firestore(config.GCP_PROJECT_ID ? { projectId: config.GCP_PROJECT_ID } : undefined);
    this.key = Buffer.from(config.YOUTUBE_TOKEN_ENCRYPTION_KEY!, 'base64');
    if (this.key.length !== 32) throw new Error('YOUTUBE_TOKEN_ENCRYPTION_KEY must be a base64-encoded 32-byte key');
  }

  private oauth() {
    return new OAuth2Client({
      clientId: this.config.YOUTUBE_OAUTH_CLIENT_ID,
      clientSecret: this.config.YOUTUBE_OAUTH_CLIENT_SECRET,
      redirectUri: this.config.YOUTUBE_OAUTH_REDIRECT_URI,
    });
  }

  private connection(ownerId: string) { return this.db.collection(this.config.FIRESTORE_YOUTUBE_CONNECTIONS_COLLECTION).doc(ownerId); }

  async status(ownerId: string): Promise<YouTubeConnectionStatus> {
    const snapshot = await this.connection(ownerId).get();
    if (!snapshot.exists) return { configured: true, connected: false };
    const value = snapshot.data() as ConnectionDocument;
    return { configured: true, connected: true, channelId: value.channelId, connectedAt: value.connectedAt, lastSyncedAt: value.lastSyncedAt, syncState: value.syncState || 'idle', syncActivity: value.syncActivity || [], lastSyncError: value.lastSyncError, syncRunId: value.currentSyncRunId, syncStartedAt: value.syncStartedAt, syncStage: value.syncStage, syncProgress: value.syncProgress };
  }

  async begin(ownerId: string) {
    const state = randomUUID();
    await this.db.collection(this.config.FIRESTORE_YOUTUBE_STATES_COLLECTION).doc(state).set({
      ownerId,
      createdAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + 10 * 60_000).toISOString(),
    });
    return this.oauth().generateAuthUrl({ access_type: 'offline', prompt: 'consent', include_granted_scopes: true, scope: scopes, state });
  }

  async finish(state: string, code: string) {
    const stateRef = this.db.collection(this.config.FIRESTORE_YOUTUBE_STATES_COLLECTION).doc(state);
    const ownerId = await this.db.runTransaction(async (transaction) => {
      const snapshot = await transaction.get(stateRef);
      if (!snapshot.exists) throw new Error('The YouTube authorization request is invalid or has already been used');
      const value = snapshot.data() as { ownerId: string; expiresAt: string };
      if (Date.parse(value.expiresAt) < Date.now()) throw new Error('The YouTube authorization request expired');
      transaction.delete(stateRef);
      return value.ownerId;
    });
    const oauth = this.oauth();
    const { tokens } = await oauth.getToken(code);
    const existing = await this.connection(ownerId).get();
    if (!tokens.refresh_token && existing.exists) {
      const previous = this.decrypt((existing.data() as ConnectionDocument).encryptedCredentials);
      tokens.refresh_token = previous.refresh_token;
    }
    if (!tokens.refresh_token) throw new Error('Google did not return an offline refresh token; reconnect and grant access');
    const now = new Date().toISOString();
    await this.connection(ownerId).set({ ownerId, encryptedCredentials: this.encrypt(tokens), connectedAt: now }, { merge: true });
  }

  async sync(ownerId: string) {
    if (!this.config.INGESTION_SERVICE_URL) throw new Error('YouTube ingestion is not configured');
    const snapshot = await this.connection(ownerId).get();
    if (!snapshot.exists) throw new Error('Connect YouTube before synchronizing analytics');
    const connection = snapshot.data() as ConnectionDocument;
    if (connection.syncState === 'running') return { started: false };
    const reference = this.connection(ownerId); const startedAt = new Date().toISOString(); const runId = randomUUID();
    const run = reference.collection('sync_runs').doc(runId); const firstActivity = { createdAt: startedAt, message: 'Sync requested from Dailies.' };
    const batch = this.db.batch();
    batch.set(reference, { ownerId, currentSyncRunId: runId, syncStartedAt: startedAt, syncStage: 'queued', syncState: 'running', syncActivity: [firstActivity], lastSyncError: FieldValue.delete(), syncProgress: FieldValue.delete() }, { merge: true });
    batch.set(run, { ownerId, runId, state: 'running', stage: 'queued', startedAt, updatedAt: startedAt, activity: [firstActivity] });
    await batch.commit();
    void this.runSync(ownerId, connection, runId).catch(async (error: any) => {
      const stoppedAt = new Date().toISOString(); const message = String(error?.message || error).slice(0, 300); const activity = { createdAt: stoppedAt, message: `Sync stopped: ${message.slice(0, 220)}` };
      const failed = this.db.batch();
      failed.set(reference, { syncState: 'failed', syncStage: 'failed', lastSyncError: message, syncActivity: FieldValue.arrayUnion(activity) }, { merge: true });
      failed.set(run, { state: 'failed', stage: 'failed', updatedAt: stoppedAt, finishedAt: stoppedAt, error: message, activity: FieldValue.arrayUnion(activity) }, { merge: true });
      await failed.commit();
    });
    return { started: true };
  }

  private async runSync(ownerId: string, connection: ConnectionDocument, runId: string) {
    const reference = this.connection(ownerId);
    const run = reference.collection('sync_runs').doc(runId);
    const target = new URL('/sync', this.config.INGESTION_SERVICE_URL); const headers: Record<string, string> = { 'content-type': 'application/json' };
    if (this.config.INGESTION_SERVICE_AUDIENCE) { const client = await new GoogleAuth().getIdTokenClient(this.config.INGESTION_SERVICE_AUDIENCE); Object.assign(headers, await client.getRequestHeaders()); }
    if (this.config.INGESTION_SERVICE_TOKEN) headers['x-dailies-service-token'] = this.config.INGESTION_SERVICE_TOKEN;
    headers.accept = 'application/x-ndjson'; const response = await fetch(target, {
      method: 'POST',
      headers,
      body: JSON.stringify({ ownerId, credentials: this.decrypt(connection.encryptedCredentials) }),
    });
    if (!response.ok || !response.body) throw new Error(`YouTube ingestion returned ${response.status}`);
    const reader = response.body.getReader(); const decoder = new TextDecoder(); let buffer = ''; let completed: any;
    const consume = async (line: string) => { if (!line.trim()) return; const event = JSON.parse(line); if (event.type === 'progress') { const createdAt = new Date().toISOString(); const message = String(event.message).slice(0, 220); const progress = progressFromMessage(message); const activity = { createdAt, message }; const connectionUpdate: Record<string, unknown> = { syncStage: progress.stage, syncActivity: FieldValue.arrayUnion(activity) }; const runUpdate: Record<string, unknown> = { stage: progress.stage, updatedAt: createdAt, activity: FieldValue.arrayUnion(activity) }; if (progress.current !== undefined && progress.total !== undefined) { connectionUpdate.syncProgress = { current: progress.current, total: progress.total }; runUpdate.progress = { current: progress.current, total: progress.total }; } const batch = this.db.batch(); batch.set(reference, connectionUpdate, { merge: true }); batch.set(run, runUpdate, { merge: true }); await batch.commit(); } else if (event.type === 'error') throw new Error(event.error?.message || 'YouTube Analytics synchronization failed'); else if (event.type === 'complete') completed = event; };
    while (true) { const { done, value } = await reader.read(); buffer += decoder.decode(value || new Uint8Array(), { stream: !done }); const lines = buffer.split('\n'); buffer = lines.pop() || ''; for (const line of lines) await consume(line); if (done) break; }
    await consume(buffer); if (!completed) throw new Error('YouTube ingestion ended without a completion record');
    const lastSyncedAt = new Date().toISOString();
    const activity = { createdAt: lastSyncedAt, message: `Sync complete: ${completed.videos} videos and ${completed.retentionPoints} retention points.` }; const finished = this.db.batch();
    finished.set(reference, { channelId: completed.channelId, lastSyncedAt, syncState: 'complete', syncStage: 'complete', syncProgress: { current: completed.videos, total: completed.videos }, syncActivity: FieldValue.arrayUnion(activity) }, { merge: true });
    finished.set(run, { state: 'complete', stage: 'complete', updatedAt: lastSyncedAt, finishedAt: lastSyncedAt, channelId: completed.channelId, videos: completed.videos, retentionPoints: completed.retentionPoints, progress: { current: completed.videos, total: completed.videos }, activity: FieldValue.arrayUnion(activity) }, { merge: true });
    await finished.commit();
  }

  async disconnect(ownerId: string) {
    const reference = this.connection(ownerId); const snapshot = await reference.get();
    if (!snapshot.exists) return;
    const credentials = this.decrypt((snapshot.data() as ConnectionDocument).encryptedCredentials);
    const token = credentials.refresh_token || credentials.access_token;
    if (token) await this.oauth().revokeToken(token).catch(() => undefined);
    await reference.delete();
  }

  successUrl(outcome: 'connected' | 'error') { return withOutcome(this.config.YOUTUBE_OAUTH_SUCCESS_URL || `${this.config.CORS_ORIGIN}/studio/`, outcome); }

  private encrypt(credentials: Credentials) {
    const iv = randomBytes(12); const cipher = createCipheriv('aes-256-gcm', this.key, iv);
    const ciphertext = Buffer.concat([cipher.update(JSON.stringify(credentials), 'utf8'), cipher.final()]);
    return [iv, cipher.getAuthTag(), ciphertext].map((part) => part.toString('base64url')).join('.');
  }

  private decrypt(value: string): Credentials {
    const [ivValue, tagValue, ciphertextValue] = value.split('.');
    if (!ivValue || !tagValue || !ciphertextValue) throw new Error('Stored YouTube credentials are invalid');
    const decipher = createDecipheriv('aes-256-gcm', this.key, Buffer.from(ivValue, 'base64url'));
    decipher.setAuthTag(Buffer.from(tagValue, 'base64url'));
    return JSON.parse(Buffer.concat([decipher.update(Buffer.from(ciphertextValue, 'base64url')), decipher.final()]).toString('utf8'));
  }
}

export function createYouTubeConnections(config: Config): YouTubeConnections {
  return config.YOUTUBE_OAUTH_CLIENT_ID && config.YOUTUBE_OAUTH_CLIENT_SECRET && config.YOUTUBE_OAUTH_REDIRECT_URI && config.YOUTUBE_TOKEN_ENCRYPTION_KEY
    ? new FirestoreYouTubeConnections(config)
    : new DisabledYouTubeConnections(config);
}

function withOutcome(target: string, outcome: 'connected' | 'error') { const url = new URL(target); url.searchParams.set('youtube', outcome); return url.toString(); }
