import { Injectable, ServiceUnavailableException } from '@nestjs/common';
import { randomUUID } from 'crypto';
import * as Minio from 'minio';

/** MinIO-backed object storage. Reports "not configured" rather than pretending to store. */
@Injectable()
export class StorageService {
  private client?: Minio.Client;
  readonly bucket = process.env.MINIO_BUCKET ?? 'quickstore';

  constructor() {
    const endpoint = process.env.MINIO_ENDPOINT;
    if (endpoint && process.env.MINIO_ROOT_USER && process.env.MINIO_ROOT_PASSWORD) {
      const url = new URL(endpoint);
      this.client = new Minio.Client({
        endPoint: url.hostname,
        port: Number(url.port || (url.protocol === 'https:' ? 443 : 80)),
        useSSL: url.protocol === 'https:',
        accessKey: process.env.MINIO_ROOT_USER,
        secretKey: process.env.MINIO_ROOT_PASSWORD,
      });
    }
  }

  get configured() {
    return !!this.client;
  }

  async put(prefix: string, buffer: Buffer, contentType: string, ext: string) {
    if (!this.client) throw new ServiceUnavailableException({ code: 'STORAGE_NOT_CONFIGURED', message: 'Object storage (MinIO) is not configured' });
    if (!(await this.client.bucketExists(this.bucket))) await this.client.makeBucket(this.bucket);
    const key = `${prefix}/${randomUUID()}.${ext}`;
    await this.client.putObject(this.bucket, key, buffer, buffer.length, { 'Content-Type': contentType });
    return { key, url: `/files/${this.bucket}/${key}` };
  }
}
