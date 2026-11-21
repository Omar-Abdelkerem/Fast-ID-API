export interface StorageDriver {
  put(key: string, buffer: Buffer, mimeType: string): Promise<void>;
  getStream(key: string): Promise<NodeJS.ReadableStream>;
  delete(key: string): Promise<void>;
}

export const STORAGE_DRIVER = Symbol('STORAGE_DRIVER');
