import { Test } from '@nestjs/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ConfigService } from '@nestjs/config';
import { HttpService } from '@nestjs/axios';
import { getRepositoryToken } from '@nestjs/typeorm';
import { Store } from 'src/database/entities/store.entity';
import { CsrfProvider } from './providers/csrf.provider';
import { UtilsService } from './utils.service';
import * as crypto from 'crypto';

describe('Utils', () => {
  let provider: UtilsService;
  let configService: { get: ReturnType<typeof vi.fn> };

  beforeEach(async () => {
    configService = { get: vi.fn() };
    configService.get.mockImplementation((key: string) => {
      const values: Record<string, unknown> = {
        shopify_api_version: '2026-10',
        shopify_api_secret: 'test-secret',
        app_url: 'https://app.example.com',
      };
      return values[key];
    });

    const module = await Test.createTestingModule({
      providers: [
        UtilsService,
        { provide: ConfigService, useValue: configService },
        { provide: HttpService, useValue: { request: vi.fn() } },
        { provide: CsrfProvider, useValue: { generateToken: vi.fn() } },
        { provide: getRepositoryToken(Store), useValue: { findOneBy: vi.fn() } },
      ],
    }).compile();

    provider = module.get<UtilsService>(UtilsService);
  });

  it('should be defined', () => {
    expect(provider).toBeDefined();
  });

  it('builds the GraphQL endpoint URL for a public store', () => {
    const store = { myshopify_domain: 'shop.myshopify.com' } as Store;
    expect(provider.getShopifyURLForStore('graphql.json', store)).toBe(
      'https://shop.myshopify.com/admin/api/2026-10/graphql.json',
    );
  });

  it('verifies a correctly signed Shopify HMAC (RFC 3986, sorted keys)', async () => {
    // Recreate what Shopify would send for these params
    const params: Record<string, string> = {
      shop: 'shop.myshopify.com',
      host: 'YXBwLWhvc3Q',
      timestamp: '1731390000',
    };
    const hmac = crypto
      .createHmac('sha256', 'test-secret')
      .update(
        Object.keys(params)
          .sort()
          .map(k => `${k}=${encodeURIComponent(params[k]).replace(/[!'()*]/g, c => '%' + c.charCodeAt(0).toString(16).toUpperCase())}`)
          .join('&'),
      )
      .digest('hex');

    const isValid = await provider.validateRequestFromShopify({
      ...params,
      hmac,
    } as never);

    expect(isValid).toBe(true);
  });

  it('rejects a tampered HMAC', async () => {
    const isValid = await provider.validateRequestFromShopify({
      shop: 'shop.myshopify.com',
      host: 'YXBwLWhvc3Q',
      timestamp: '1731390000',
      hmac: 'deadbeef',
    } as never);

    expect(isValid).toBe(false);
  });
});
