import { createClient } from '@clickhouse/client'; import type { RetentionPoint } from './youtubeAnalytics.js';
type VideoRow = { video_id: string; channel_id: string; title: string; published_at: string; duration_seconds: number };
export async function writeRetention(entries: { video: VideoRow; points: RetentionPoint[] }[], ownerId: string, onProgress: (message: string) => void = () => undefined) {
  const client = createClient({ url: `${process.env.CLICKHOUSE_SECURE === 'false' ? 'http' : 'https'}://${required('CLICKHOUSE_HOST')}:${process.env.CLICKHOUSE_PORT || (process.env.CLICKHOUSE_SECURE === 'false' ? '8123' : '8443')}`, username: required('CLICKHOUSE_INGEST_USER'), password: required('CLICKHOUSE_INGEST_PASSWORD'), database: process.env.CLICKHOUSE_DATABASE || 'default' });
  try { let current = 0; for (const entry of entries) { current += 1; await client.insert({ table: 'videos', values: [{ ...entry.video, channel_id: ownerId }], format: 'JSONEachRow' }); if (entry.points.length) await client.insert({ table: 'retention_curve_points', values: entry.points, format: 'JSONEachRow' }); onProgress(`Stored retention history ${current} of ${entries.length}.`); } } finally { await client.close(); }
  return { videos: entries.length, retentionPoints: entries.reduce((sum, entry) => sum + entry.points.length, 0) };
}
const required = (name: string) => { const value = process.env[name]; if (!value) throw new Error(`${name} is required`); return value; };
