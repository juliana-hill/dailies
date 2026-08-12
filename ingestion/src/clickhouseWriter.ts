import { createClient } from '@clickhouse/client'; import type { RetentionPoint } from './youtubeAnalytics.js';
type VideoRow = { video_id: string; channel_id: string; title: string; published_at: string; duration_seconds: number };
export async function writeRetention(entries: { video: VideoRow; points: RetentionPoint[] }[]) {
  const client = createClient({ url: `${process.env.CLICKHOUSE_SECURE === 'false' ? 'http' : 'https'}://${required('CLICKHOUSE_HOST')}:${process.env.CLICKHOUSE_PORT || (process.env.CLICKHOUSE_SECURE === 'false' ? '8123' : '8443')}`, username: required('CLICKHOUSE_INGEST_USER'), password: required('CLICKHOUSE_INGEST_PASSWORD'), database: process.env.CLICKHOUSE_DATABASE || 'default' });
  try { for (const entry of entries) { await client.insert({ table: 'videos', values: [entry.video], format: 'JSONEachRow' }); if (entry.points.length) await client.insert({ table: 'retention_curve_points', values: entry.points, format: 'JSONEachRow' }); } } finally { await client.close(); }
  return { videos: entries.length, retentionPoints: entries.reduce((sum, entry) => sum + entry.points.length, 0) };
}
const required = (name: string) => { const value = process.env[name]; if (!value) throw new Error(`${name} is required`); return value; };
