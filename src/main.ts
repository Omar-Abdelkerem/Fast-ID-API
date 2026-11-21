import { ConfigService } from '@nestjs/config';
import { NestFactory } from '@nestjs/core';
import { Logger } from 'nestjs-pino';
import { AppModule } from './app.module';
import { configureApp } from './app.setup';

async function bootstrap(): Promise<void> {
  const app = await NestFactory.create(AppModule, {
    bodyParser: false,
    bufferLogs: true,
  });

  configureApp(app);

  const configService = app.get(ConfigService);
  const port = configService.get<number>('PORT', 3000);
  const logger = app.get(Logger);

  await app.listen(port);
  logger.log(`Fast ID API listening on port ${port}`);
}

void bootstrap();
