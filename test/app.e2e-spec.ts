import { Test } from '@nestjs/testing';
import { INestApplication } from '@nestjs/common';
import { beforeAll, afterAll, describe, it } from 'vitest';
import request from 'supertest';
import { NestExpressApplication } from '@nestjs/platform-express';
import { join } from 'path';
import cookieParser from 'cookie-parser';
import { AppModule } from '../src/app.module';

/**
 * These e2e tests boot the full application and therefore require a running
 * PostgreSQL and Redis (see env_format.env for the expected configuration):
 *
 *   DB_TYPE=postgres DB_HOST=localhost DB_PORT=5432 ... REDIS_HOST=localhost
 */
const requiredEnv = ['DB_HOST', 'DB_USERNAME', 'DB_NAME', 'REDIS_HOST'];
const missingEnv = requiredEnv.filter(name => !process.env[name]);
const suite = missingEnv.length === 0 ? describe : describe.skip;

suite('AppController (e2e)', () => {
  let app: INestApplication;

  beforeAll(async () => {
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
    await app.close();
  });

  it('GET / renders the login page', () => {
    return request(app.getHttpServer())
      .get('/')
      .expect(200)
      .expect(/Shopify App/);
  });
});
