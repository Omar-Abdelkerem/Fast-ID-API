import { ConfigService } from '@nestjs/config';
import { PrismaService } from '../../database/prisma.service';
import { SeedService } from './seed.service';

describe('SeedService', () => {
  function createMocks(options: { adminCount: number; email?: string; password?: string }) {
    const createMock = jest.fn().mockResolvedValue({});
    const tx = {
      $executeRaw: jest.fn().mockResolvedValue(1),
      users: {
        count: jest.fn().mockResolvedValue(options.adminCount),
        create: createMock,
      },
    };
    const prisma = {
      $executeRaw: jest.fn().mockResolvedValue(1),
      $transaction: jest
        .fn()
        .mockImplementation((fn: (t: typeof tx) => Promise<unknown>) => fn(tx)),
    } as unknown as PrismaService;

    const configMap: Record<string, string | undefined> = {
      SEED_ADMIN_EMAIL: options.email,
      SEED_ADMIN_PASSWORD: options.password,
    };
    const configService = {
      get: (key: string) => configMap[key],
    } as unknown as ConfigService;

    return { prisma, configService, createMock };
  }

  it('fails boot when zero ADMIN rows exist and SEED_ADMIN_* vars are missing', async () => {
    const { prisma, configService } = createMocks({ adminCount: 0 });
    const service = new SeedService(prisma, configService);

    await expect(service.ensureBootstrapData()).rejects.toThrow(/Zero ADMIN accounts exist/);
  });

  it('creates initial ADMIN with must_change_password=true when zero ADMIN rows exist', async () => {
    const { prisma, configService, createMock } = createMocks({
      adminCount: 0,
      email: 'Admin@Example.com',
      password: 'StrongBootPassword2026!',
    });
    const service = new SeedService(prisma, configService);

    await service.ensureBootstrapData();

    expect(createMock).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          role: 'ADMIN',
          email: 'admin@example.com',
          must_change_password: true,
          is_active: true,
        }),
      }),
    );
  });

  it('skips admin seeding when at least one ADMIN already exists even without SEED_ADMIN_*', async () => {
    const { prisma, configService, createMock } = createMocks({ adminCount: 1 });
    const service = new SeedService(prisma, configService);

    await expect(service.ensureBootstrapData()).resolves.toBeUndefined();
    expect(createMock).not.toHaveBeenCalled();
  });
});
