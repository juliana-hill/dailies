import { Storage } from '@google-cloud/storage';
import { GoogleAuth, Impersonated } from 'google-auth-library';
import type { Config } from './config.js';

export interface AssetStorage {
  put(path: string, data: Buffer, contentType: string): Promise<{ sizeBytes: number }>;
  signedWriteUrl(path: string, contentType: string): Promise<{ url: string; expiresAt: string }>;
  size(path: string): Promise<number>;
  read(path: string): Promise<Buffer>;
  signedReadUrl(path: string): Promise<{ url: string; expiresAt: string }>;
}
export class GcsAssetStorage implements AssetStorage {
  private storage?: Storage;
  constructor(private readonly config: Config) {}
  private async client() { if (this.storage) return this.storage; const target = process.env.IMPERSONATE_SERVICE_ACCOUNT; if (!target) return this.storage = new Storage({ projectId: this.config.GCP_PROJECT_ID }); const sourceClient = await new GoogleAuth({ scopes: ['https://www.googleapis.com/auth/cloud-platform'] }).getClient(); const authClient = new Impersonated({ sourceClient, targetPrincipal: target, targetScopes: ['https://www.googleapis.com/auth/cloud-platform'], lifetime: 3600 }); return this.storage = new Storage({ projectId: this.config.GCP_PROJECT_ID, authClient }); }
  private async file(path: string) { if (!this.config.GCS_BUCKET) throw new Error('GCS_BUCKET is required'); return (await this.client()).bucket(this.config.GCS_BUCKET).file(path); }
  async put(path: string, data: Buffer, contentType: string) { await (await this.file(path)).save(data, { resumable: false, contentType, metadata: { cacheControl: 'private, max-age=0' } }); return { sizeBytes: data.byteLength }; }
  async signedWriteUrl(path: string, contentType: string) { const expires = Date.now() + 24 * 60 * 60_000; const [url] = await (await this.file(path)).getSignedUrl({ action: 'write', expires, contentType, version: 'v4' }); return { url, expiresAt: new Date(expires).toISOString() }; }
  async size(path: string) { const [metadata] = await (await this.file(path)).getMetadata(); return Number(metadata.size); }
  async read(path: string) { const [data] = await (await this.file(path)).download(); return data; }
  async signedReadUrl(path: string) { const expires = Date.now() + 15 * 60_000; const [url] = await (await this.file(path)).getSignedUrl({ action: 'read', expires }); return { url, expiresAt: new Date(expires).toISOString() }; }
}
export class MemoryAssetStorage implements AssetStorage {
  values = new Map<string, Buffer>();
  async put(path: string, data: Buffer) { this.values.set(path, data); return { sizeBytes: data.byteLength }; }
  async signedWriteUrl(): Promise<{ url: string; expiresAt: string }> { throw new Error('Signed writes are unavailable in fixture mode'); }
  async size(path: string) { const value = this.values.get(path); if (!value) throw new Error('ASSET_NOT_FOUND'); return value.byteLength; }
  async read(path: string) { const value = this.values.get(path); if (!value) throw new Error('ASSET_NOT_FOUND'); return value; }
  async signedReadUrl(path: string) { if (!this.values.has(path)) throw new Error('ASSET_NOT_FOUND'); return { url: `memory://${path}`, expiresAt: new Date(Date.now() + 900_000).toISOString() }; }
}
