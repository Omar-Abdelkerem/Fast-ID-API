import { PassThrough } from 'stream';
import { ConfigService } from '@nestjs/config';
import { v2 as cloudinary } from 'cloudinary';
import { CloudinaryStorageDriver, parseCloudinaryCredentials } from './cloudinary.storage';

function makeConfig(values: Record<string, string | undefined>): ConfigService {
  return {
    get: jest.fn((key: string, defaultValue?: string) => values[key] ?? defaultValue),
  } as unknown as ConfigService;
}

describe('CloudinaryStorageDriver', () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('parses individual credentials and CLOUDINARY_URL cleanly', () => {
    expect(
      parseCloudinaryCredentials({
        cloudName: 'demo-cloud',
        apiKey: '12345',
        apiSecret: 'secret-val',
      }),
    ).toEqual({
      cloudName: 'demo-cloud',
      apiKey: '12345',
      apiSecret: 'secret-val',
    });

    expect(
      parseCloudinaryCredentials({
        cloudinaryUrl: 'cloudinary://98765:my-secret@my-cloud',
      }),
    ).toEqual({
      cloudName: 'my-cloud',
      apiKey: '98765',
      apiSecret: 'my-secret',
    });

    expect(() => parseCloudinaryCredentials({})).toThrow(/not configured/i);
  });

  it('sanitizes traversal segments when building public_id', () => {
    const configSpy = jest.spyOn(cloudinary, 'config').mockReturnValue({} as never);
    const driver = new CloudinaryStorageDriver(
      makeConfig({
        STORAGE_DRIVER: 'cloudinary',
        CLOUDINARY_CLOUD_NAME: 'demo-cloud',
        CLOUDINARY_API_KEY: '12345',
        CLOUDINARY_API_SECRET: 'secret-val',
        CLOUDINARY_FOLDER: '/fast-id/',
      }),
    );

    expect(configSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        cloud_name: 'demo-cloud',
        api_key: '12345',
        api_secret: 'secret-val',
        secure: true,
      }),
    );
    expect(driver.buildPublicId('applications/abc/file.pdf')).toBe(
      'fast-id/applications/abc/file.pdf',
    );
    expect(driver.buildPublicId('../applications/../../abc/file.png')).toBe(
      'fast-id/applications/abc/file.png',
    );
  });

  it('uploads raw authenticated assets via upload_stream', async () => {
    jest.spyOn(cloudinary, 'config').mockReturnValue({} as never);
    const receivedChunks: Buffer[] = [];
    const uploadSpy = jest.spyOn(cloudinary.uploader, 'upload_stream').mockImplementation(((
      _options: unknown,
      cb?: (err: unknown, result?: unknown) => void,
    ) => {
      const stream = new PassThrough();
      stream.on('data', (chunk: Buffer) => receivedChunks.push(chunk));
      stream.on('finish', () => cb?.(null, { public_id: 'fast-id/applications/a/b.png' }));
      return stream;
    }) as never);

    const driver = new CloudinaryStorageDriver(
      makeConfig({
        STORAGE_DRIVER: 'cloudinary',
        CLOUDINARY_CLOUD_NAME: 'demo-cloud',
        CLOUDINARY_API_KEY: '12345',
        CLOUDINARY_API_SECRET: 'secret-val',
      }),
    );

    const bytes = Buffer.from('hello-cloudinary');
    await driver.put('applications/a/b.png', bytes, 'image/png');

    expect(uploadSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        public_id: 'fast-id/applications/a/b.png',
        resource_type: 'raw',
        type: 'authenticated',
        overwrite: true,
        invalidate: true,
      }),
      expect.any(Function),
    );
    expect(Buffer.concat(receivedChunks)).toEqual(bytes);
  });

  it('streams private downloads via short-lived signed URL and deletes idempotently', async () => {
    jest.spyOn(cloudinary, 'config').mockReturnValue({} as never);
    const urlSpy = jest
      .spyOn(cloudinary.utils, 'private_download_url')
      .mockReturnValue('https://api.cloudinary.com/v1_1/demo-cloud/raw/download?sig=1');

    const payload = Buffer.from('signed-bytes');
    const fetchSpy = jest.spyOn(global, 'fetch').mockResolvedValue(
      new Response(payload, {
        status: 200,
        headers: { 'Content-Type': 'application/octet-stream' },
      }),
    );

    const destroySpy = jest
      .spyOn(cloudinary.uploader, 'destroy')
      .mockResolvedValue({ result: 'ok' } as never);

    const driver = new CloudinaryStorageDriver(
      makeConfig({
        STORAGE_DRIVER: 'cloudinary',
        CLOUDINARY_CLOUD_NAME: 'demo-cloud',
        CLOUDINARY_API_KEY: '12345',
        CLOUDINARY_API_SECRET: 'secret-val',
      }),
    );

    const stream = await driver.getStream('applications/a/b.pdf');
    const chunks: Buffer[] = [];
    for await (const chunk of stream) {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    }

    expect(urlSpy).toHaveBeenCalledWith(
      'fast-id/applications/a/b.pdf',
      '',
      expect.objectContaining({
        resource_type: 'raw',
        type: 'authenticated',
        expires_at: expect.any(Number),
      }),
    );
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(Buffer.concat(chunks)).toEqual(payload);

    await driver.delete('applications/a/b.pdf');
    expect(destroySpy).toHaveBeenCalledWith('fast-id/applications/a/b.pdf', {
      resource_type: 'raw',
      type: 'authenticated',
      invalidate: true,
    });
  });
});
