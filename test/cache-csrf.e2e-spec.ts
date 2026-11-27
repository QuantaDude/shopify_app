import { describe, expect, it, beforeAll, afterAll } from 'vitest';
import { ConfigService } from '@nestjs/config';
import { CacheModule } from '../src/data/cache/cache.module';
import { CacheService } from '../src/data/cache/cache.service';
import { CsrfMiddleware } from '../src/middlewares/csrf.middleware';
import { CsrfProvider } from '../src/utils/providers/csrf.provider';
import cookieParser from 'cookie-parser';
import express, { type Express } from 'express';
import request from 'supertest';

/**
 * Integration tests for the two flows that were silently broken before:
 *
 *  1. The Redis cache stack (cacheable + keyv + @keyv/redis): a version drift
 *     between @keyv/redis v6 (expects ABSOLUTE epoch-ms expiry) and keyv v5
 *     (sends RELATIVE TTLs) made every TTL'd key expire instantly — which is
 *     why nonces "never validated" and credits never hit the cache. This test
 *     fails immediately if that contract ever drifts again.
 *
 *  2. The consolidated CSRF flow: CsrfProvider owns the only double-csrf
 *     instance and CsrfMiddleware delegates to it; a token minted by the
 *     provider must validate through the middleware.
 *
 * Runs against a reachable Redis (defaults to localhost:6379), same as the app.
 */
describe('cache and csrf integration', () => {
  let cacheService: CacheService;

  beforeAll(async () => {
    const { Test } = await import('@nestjs/testing');
    const testingModule = await Test.createTestingModule({
      imports: [CacheModule],
    }).compile();
    cacheService = testingModule.get(CacheService);
  });

  afterAll(async () => {
    // no-op: CacheModule closes its clients on app shutdown
  });

  describe('cache TTL contract (nonce/credits regression guard)', () => {
    it('reads back a value stored with a TTL', async () => {
      const ok = await cacheService.set('shopify:nonce:test:roundtrip', 'test-store.myshopify.com', '10m');
      expect(ok).toBe(true);

      const value = await cacheService.get<string>('shopify:nonce:test:roundtrip');
      expect(value).toBe('test-store.myshopify.com');
    });

    it('reads back the nonce the way DataService stores and validates it', async () => {
      const nonce = 'deadbeefdeadbeefdeadbeefdeadbeef';
      await cacheService.set(`shopify:nonce:${nonce}`, 'test-store.myshopify.com', '10m');

      const storedShopDomain = await cacheService.get<string>(`shopify:nonce:${nonce}`);
      expect(storedShopDomain).toBe('test-store.myshopify.com');

      await cacheService.delete(`shopify:nonce:${nonce}`);
      expect(await cacheService.get(`shopify:nonce:${nonce}`)).toBeUndefined();
    });

    it('stores numbers (credits) with a TTL and updates them', async () => {
      await cacheService.set('12345-credits', 10, '5m');
      expect(await cacheService.get<number>('12345-credits')).toBe(10);

      await cacheService.set('12345-credits', 8, '5m');
      expect(await cacheService.get<number>('12345-credits')).toBe(8);

      await cacheService.delete('12345-credits');
    });
  });

  describe('consolidated CSRF flow', () => {
    let app: Express;
    let csrfProvider: CsrfProvider;

    beforeAll(() => {
      const configService = new ConfigService({ csrf_secret: 'integration-test-secret' });
      csrfProvider = new CsrfProvider(configService);

      app = express();
      app.use(cookieParser());
      // Nest calls middleware methods on the instance; mirror that here.
      const middleware = new CsrfMiddleware(csrfProvider);
      app.use(middleware.use.bind(middleware));

      // A route that mints a token, like the web-app pages do.
      app.get('/token', (req, res) => {
        const token = csrfProvider.generateToken(req, res);
        res.json({ token });
      });

      app.post('/action', (req, res) => {
        res.status(200).json({ ok: true });
      });
    });

    it('mints a token via GET without needing an existing token (safe method)', async () => {
      // Logged-in pages always carry the access_token cookie; the CSRF token is
      // bound to that session identifier.
      const res = await request(app).get('/token').set('Cookie', 'access_token=a-session');
      expect(res.status).toBe(200);
      expect(res.body.token).toBeTruthy();
    });

    it('rejects state-changing requests without a token', async () => {
      const res = await request(app).post('/action');
      expect(res.status).toBe(403);
    });

    it('accepts a state-changing request with the minted token + cookie', async () => {
      // 1. Mint a token (the response sets the httpOnly x-csrf-token cookie).
      const mintRes = await request(app).get('/token').set('Cookie', 'access_token=a-session');
      expect(mintRes.status).toBe(200);
      const token = mintRes.body.token as string;
      const setCookie: string = mintRes.headers['set-cookie']?.[0] ?? '';
      const cookie = setCookie.split(';')[0];
      expect(cookie).toContain('x-csrf-token=');

      // 2. POST with the session cookie, the CSRF cookie and the matching header token.
      const res = await request(app)
        .post('/action')
        .set('Cookie', `access_token=a-session; ${cookie}`)
        .set('x-csrf-token', token);
      expect(res.status).toBe(200);
    });
  });
});
