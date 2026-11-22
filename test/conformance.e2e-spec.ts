import './helpers/test-env';
import * as fs from 'fs';
import * as path from 'path';
import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { AppModule } from '../src/app.module';
import { configureApp } from '../src/app.setup';

interface ExpressLayer {
  route?: {
    path: string;
    methods: Record<string, boolean>;
  };
}

interface ExpressAppLike {
  _router?: {
    stack?: ExpressLayer[];
  };
}

function parseContractEndpoints(markdown: string): string[] {
  const regex = /^##\s+\d+\.\d+\s+`(GET|POST|PATCH|DELETE|PUT)\s+(\/api\/v1[^`]+)`/gm;
  const routes: string[] = [];
  let match: RegExpExecArray | null;
  while ((match = regex.exec(markdown)) !== null) {
    routes.push(`${match[1]} ${match[2]}`);
  }
  return routes.sort();
}

function extractMountedEndpoints(app: INestApplication): string[] {
  const expressApp = app.getHttpAdapter().getInstance() as ExpressAppLike;
  const stack = expressApp._router?.stack ?? [];
  const routes: string[] = [];

  for (const layer of stack) {
    if (!layer.route || layer.route.methods._all) {
      continue;
    }
    const routePath = layer.route.path;
    // Skip NestJS global middleware wildcard registrations (e.g. nestjs-pino forRoutes('*'))
    if (routePath === '/api/v1$' || routePath === '/api/v1/*') {
      continue;
    }
    const methods = Object.entries(layer.route.methods)
      .filter(([, enabled]) => enabled)
      .map(([method]) => method.toUpperCase());

    for (const method of methods) {
      routes.push(`${method} ${routePath}`);
    }
  }

  return routes.sort();
}

describe('Contract v1.0.3-mvp 63-Endpoint Conformance Sweep (e2e)', () => {
  let app: INestApplication;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    app = moduleRef.createNestApplication();
    configureApp(app);
    await app.init();
  });

  afterAll(async () => {
    await app.close();
  });

  it('mounts every one of the 63 endpoints from docs/Fast_ID_API_Contract.md with exact method and path, zero extras, and zero PUT routes', () => {
    const contractPath = path.resolve(__dirname, '..', 'docs', 'Fast_ID_API_Contract.md');
    const contractText = fs.readFileSync(contractPath, 'utf8');

    const expectedEndpoints = parseContractEndpoints(contractText);
    const mountedEndpoints = extractMountedEndpoints(app);

    expect(expectedEndpoints).toHaveLength(63);

    const missing = expectedEndpoints.filter((r) => !mountedEndpoints.includes(r));
    const unexpected = mountedEndpoints.filter((r) => !expectedEndpoints.includes(r));

    expect(missing).toEqual([]);
    expect(unexpected).toEqual([]);
    expect(mountedEndpoints.some((r) => r.startsWith('PUT '))).toBe(false);
    expect(mountedEndpoints).toEqual(expectedEndpoints);
  });
});
