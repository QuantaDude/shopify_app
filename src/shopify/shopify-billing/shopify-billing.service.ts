import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { AxiosHeaders } from 'axios';
import { print } from 'graphql';
import { Store } from '../../database/entities/store.entity';
import { UtilsService } from '../../utils/utils.service';
import { ShopifyRequestOptions } from '../../utils/types/ShopifyRequestOptions';
import { GetSubscriptionStateDocument, GetSubscriptionStateQuery } from '../../generated/graphql';

/**
 * Verifies billing claims (planId / storeId / charge_id) that arrive on the
 * /shopify/rac return URL against Shopify's own subscription state.
 *
 * The return URL is built by our app, but it executes in the merchant's
 * browser, so its query params cannot be trusted: without verification anyone
 * could craft a URL that grants an arbitrary plan to an arbitrary store.
 */
@Injectable()
export class ShopifyBillingService {
  private readonly logger = new Logger(ShopifyBillingService.name);

  private readonly getSubscriptionStateQuery: string = print(GetSubscriptionStateDocument);

  constructor(
    private readonly utilsService: UtilsService,
    private readonly configService: ConfigService,
    @InjectRepository(Store)
    private readonly storesRepository: Repository<Store>,
  ) {}

  /**
   * Fetches the app's subscriptions for the given store from Shopify and checks
   * that the charge actually exists, belongs to this store's installation, and
   * names the plan the URL claims.
   */
  public async verifyCharge(
    storeId: number,
    chargeId: string | number,
  ): Promise<{ verified: boolean; reason?: string; status?: string }> {
    // The billing returnUrl carries the store's Shopify numeric id.
    const store = await this.storesRepository.findOneBy({ id: storeId });
    if (!store) {
      return { verified: false, reason: `store ${storeId} not found` };
    }

    const options: ShopifyRequestOptions = {
      url: this.utilsService.getShopifyURLForStore('graphql.json', store),
      headers: new AxiosHeaders()
        .set('Content-Type', 'application/json')
        .set('X-Shopify-Access-Token', store.access_token),
      data: {
        query: this.getSubscriptionStateQuery,
        variables: { apiKey: this.configService.get<string>('shopify_api_key') },
      },
    };

    const response = await this.utilsService.requestToShopify<GetSubscriptionStateQuery>('post', options);
    if (response.error || (response.statusCode ?? 0) >= 400) {
      return {
        verified: false,
        reason: `subscription state query failed with ${response.statusCode}`,
      };
    }

    const subscriptions = response.respBody?.appByKey?.installation?.activeSubscriptions ?? [];
    const match = subscriptions.find(sub => sub.id.endsWith(`/${chargeId}`));
    if (!match) {
      return { verified: false, reason: `charge ${chargeId} not found in store ${storeId}'s installation` };
    }
    if (match.status !== 'ACTIVE' && match.status !== 'ACCEPTED') {
      return {
        verified: false,
        reason: `charge ${chargeId} for store ${storeId} has status ${match.status}`,
      };
    }

    return { verified: true, status: match.status };
  }
}
