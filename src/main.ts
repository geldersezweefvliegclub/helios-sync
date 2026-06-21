import 'dotenv/config';
import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { Logger } from '@nestjs/common';
import { AppModule } from './app.module';
import { WinstonModule } from 'nest-winston';
import * as winston from 'winston';
import { SeqTransport } from '@datalust/winston-seq';

const createLogger = () => WinstonModule.createLogger({
  level: process.env.LOGGER_LEVEL || 'info',
  format: winston.format.combine(
    winston.format.errors({ stack: true }),
    winston.format.json(),
  ),
  defaultMeta: {
    Application: 'helios-sync',
    Instance: process.env.INSTANCE || 'Local',
    Environment: process.env.NODE_ENV || 'Local',
  },
  transports: [
    new winston.transports.Console({
      format: winston.format.combine(
        winston.format.colorize({ all: true }),
        winston.format.simple(),
      ),
    }),
    ...(process.env.LOGGER_SERVER_URL ? [new SeqTransport({
      serverUrl: process.env.LOGGER_SERVER_URL,
      apiKey: process.env.LOGGER_API_KEY,
      onError: (e: Error) => { console.error(e); },
      handleExceptions: true,
      handleRejections: true,
    })] : []),
  ],
});

async function bootstrap() {
  const app = await NestFactory.createApplicationContext(AppModule, {
    logger: createLogger(),
  });
  const logger = new Logger('Application');

  logger.log('helios-sync started');

  const shutdown = async (signal: string) => {
    logger.log(`Received ${signal}, shutting down gracefully...`);
    await app.close();
    process.exit(0);
  };

  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
}

bootstrap().catch((err) => {
  console.error('Failed to start application:', err);
  process.exit(1);
});