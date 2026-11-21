import { EnvConfig } from './env.schema';

export interface AppConfig {
  nodeEnv: EnvConfig['NODE_ENV'];
  port: number;
  databaseUrl: string;
  jwtSecret: string;
  cookie: {
    sameSite: EnvConfig['COOKIE_SAMESITE'];
    domain?: string;
    secure: boolean;
  };
  corsOrigins: string[];
  frontendBaseUrl: string;
  trustProxy: boolean | number;
  email: {
    driver: EnvConfig['EMAIL_DRIVER'];
    apiKey?: string;
    from?: string;
  };
  storage: {
    driver: EnvConfig['STORAGE_DRIVER'];
    localPath?: string;
    bucket?: string;
    endpoint?: string;
    accessKey?: string;
    secretKey?: string;
    region?: string;
  };
  paymentMode: EnvConfig['PAYMENT_MODE'];
  seedAdmin: {
    email?: string;
    password?: string;
  };
  logLevel: EnvConfig['LOG_LEVEL'];
}

export function buildAppConfig(env: EnvConfig): AppConfig {
  return {
    nodeEnv: env.NODE_ENV,
    port: env.PORT,
    databaseUrl: env.DATABASE_URL,
    jwtSecret: env.JWT_SECRET,
    cookie: {
      sameSite: env.COOKIE_SAMESITE,
      domain: env.COOKIE_DOMAIN,
      secure: env.NODE_ENV !== 'development',
    },
    corsOrigins: env.CORS_ORIGINS,
    frontendBaseUrl: env.FRONTEND_BASE_URL,
    trustProxy: env.TRUST_PROXY,
    email: {
      driver: env.EMAIL_DRIVER,
      apiKey: env.EMAIL_PROVIDER_API_KEY,
      from: env.EMAIL_FROM,
    },
    storage: {
      driver: env.STORAGE_DRIVER,
      localPath: env.STORAGE_LOCAL_PATH,
      bucket: env.STORAGE_BUCKET,
      endpoint: env.STORAGE_ENDPOINT,
      accessKey: env.STORAGE_ACCESS_KEY,
      secretKey: env.STORAGE_SECRET_KEY,
      region: env.STORAGE_REGION,
    },
    paymentMode: env.PAYMENT_MODE,
    seedAdmin: {
      email: env.SEED_ADMIN_EMAIL,
      password: env.SEED_ADMIN_PASSWORD,
    },
    logLevel: env.LOG_LEVEL,
  };
}
