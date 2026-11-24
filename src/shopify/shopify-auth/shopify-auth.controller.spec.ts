import { Test } from '@nestjs/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ConfigService } from '@nestjs/config';
import { ShopifyAuthController } from './shopify-auth.controller';
import { ShopifyAuthService } from './shopify-auth.service';
import { UtilsService } from 'src/utils/utils.service';
import { JobsService } from 'src/jobs/jobs.service';

describe('InstallationController', () => {
  let controller: ShopifyAuthController;

  beforeEach(async () => {
    const module = await Test.createTestingModule({
      controllers: [ShopifyAuthController],
      providers: [
        {
          provide: ShopifyAuthService,
          useValue: {
            isAccessTokenValid: vi.fn(),
            getOAuthURL: vi.fn(),
            validateNonce: vi.fn(),
            getAccessTokenForStore: vi.fn(),
            getShopDetailsFromShopify: vi.fn(),
            saveStoreDetails: vi.fn(),
            updateAccessToken: vi.fn(),
          },
        },
        {
          provide: UtilsService,
          useValue: { validateRequestFromShopify: vi.fn(), getStoreByDomain: vi.fn(), isAppEmbedded: vi.fn(() => false) },
        },
        { provide: ConfigService, useValue: { get: vi.fn() } },
        { provide: JobsService, useValue: {} },
      ],
    }).compile();

    controller = module.get<ShopifyAuthController>(ShopifyAuthController);
  });

  it('should be defined', () => {
    expect(controller).toBeDefined();
  });
});
