import { describe, beforeEach, expect, it, vi } from 'vitest';
import { Test } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import { ShopifyAuthService } from './shopify-auth.service';
import { CreateStoreProvider } from './providers/create-store.provider';
import { CreateSuperAdmin } from './providers/create-super-admin';
import { JobsService } from 'src/jobs/jobs.service';
import { DataService } from '../../data/data.service';
import { UtilsService } from 'src/utils/utils.service';

describe('InstallationService', () => {
  let service: ShopifyAuthService;

  beforeEach(async () => {
    const module = await Test.createTestingModule({
      providers: [
        ShopifyAuthService,
        {
          provide: UtilsService,
          useValue: {
            getShopifyURLForStore: vi.fn(() => 'https://shop.myshopify.com/admin/api/2026-10/graphql.json'),
            getShopifyStoreURL: vi.fn(() => 'https://shop.myshopify.com/admin/api/2026-10/graphql.json'),
            requestToShopify: vi.fn(),
          },
        },
        { provide: ConfigService, useValue: { get: vi.fn() } },
        {
          provide: JobsService,
          useValue: {
            syncProducts: vi.fn(),
            syncOrders: vi.fn(),
            syncCustomers: vi.fn(),
            configure: vi.fn(),
            activateTrial: vi.fn(),
            resumePausedJobsForStore: vi.fn(),
          },
        },
        { provide: CreateStoreProvider, useValue: { createStore: vi.fn() } },
        { provide: CreateSuperAdmin, useValue: { create: vi.fn() } },
        { provide: DataService, useValue: { updateStoreToken: vi.fn(), storeNonce: vi.fn(), validateAndRemoveNonce: vi.fn() } },
      ],
    }).compile();

    service = module.get<ShopifyAuthService>(ShopifyAuthService);
  });

  it('should be defined', () => {
    expect(service).toBeDefined();
  });
});
