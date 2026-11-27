import { Test } from '@nestjs/testing';
import { beforeAll, afterAll, describe, it } from 'vitest';
import request from 'supertest';
import { NestExpressApplication } from '@nestjs/platform-express';
import { join } from 'path';
import net from 'node:net';
import cookieParser from 'cookie-parser';
import { AppModule } from '../src/app.module';

/**
 * These e2e tests boot the full application and therefore require a running
 * PostgreSQL and Redis (see env_format.env for the expected configuration):
 *
 *   DB_TYPE=postgres DB_HOST=localhost DB_PORT=5432 ... REDIS_HOST=localhost
 *
 * When either service is not reachable the suite skips itself instead of
 * failing, so `npm test` stays green on machines without the stack.
 */
const canConnect = (host: string, port: number, timeoutMs = 1000): Promise<boolean> =>
  new Promise(resolve => {
    const socket = new net.Socket();
    const done = (ok: boolean) => {
      socket.destroy();
      resolve(ok);
    };
    socket.setTimeout(timeoutMs);
    socket.once('connect', () => done(true));
    socket.once('timeout', () => done(false));
    socket.once('error', () => done(false));
    socket.connect(port, host);
  });

const dbHost = process.env.DB_HOST ?? 'localhost';
const dbPort = parseInt(process.env.DB_PORT ?? '5432', 10);
const redisHost = process.env.REDIS_HOST ?? 'localhost';
const redisPort = parseInt(process.env.REDIS_PORT ?? '6379', 10);

describe('AppController (e2e)', () => {
  let app: NestExpressApplication;
  let servicesUp = false;

  beforeAll(async () => {
    // Only boot the full application when PostgreSQL and Redis are actually
    // reachable; otherwise every test below skips itself.
    const [dbReachable, redisReachable] = await Promise.all([
      canConnect(dbHost, dbPort),
      canConnect(redisHost, redisPort),
    ]);
    servicesUp = dbReachable && redisReachable;
    if (!servicesUp) {
      return;
    }

    const moduleFixture = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    app = moduleFixture.createNestApplication<NestExpressApplication>();
    app.use(cookieParser(process.env.APP_SECRET));
    app.useStaticAssets(join(__dirname, '..', 'public'));
    app.setBaseViewsDir(join(__dirname, '..', 'views'));
    app.setViewEngine('ejs');
    await app.init();
  });

  afterAll(async () => {
    // beforeAll may have failed (e.g. no PostgreSQL reachable) — don't crash the run twice.
    await app?.close();
  });

  it('GET / renders the login page', ({ skip }) => {
    if (!servicesUp) {
      return skip();
    }
    return request(app.getHttpServer())
      .get('/')
      .expect(200)
      .expect(/Shopify App/);
  });
});
