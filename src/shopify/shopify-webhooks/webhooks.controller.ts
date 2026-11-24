import { Body, Controller, Inject, Logger, Post, Req, UseGuards } from '@nestjs/common';
import { HashVerificationGuard } from '../guards/hash-verification.guard';
import { Request } from 'express';
import { DataService } from 'src/data/data.service';
import { InjectRepository } from '@nestjs/typeorm';
import { Store } from 'src/database/entities/store.entity';
import { Repository } from 'typeorm';

@Controller() //@Controller('webhook')
@UseGuards(HashVerificationGuard)
export class WebhooksController {
  private readonly logger = new Logger(WebhooksController.name);

  constructor(
    private readonly dataService: DataService,
    @InjectRepository(Store) private readonly storesRepository: Repository<Store>,
  ) {}

  /**
   * When the app is uninstalled the access token is revoked immediately.
   * Clearing it here lets the app fall back to the OAuth re-authorization
   * flow instead of hammering Shopify with a dead token.
   */
  @Post('app/uninstalled')
  public async removeStore(@Body() body: { shop_domain?: string }) {
    this.logger.warn(`App uninstalled for ${body?.shop_domain}`);
    if (body?.shop_domain) {
      const store = await this.storesRepository.findOneBy({ myshopify_domain: body.shop_domain });
      if (store != null && store.access_token?.length > 0) {
        await this.storesRepository.update({ id: store.id }, { access_token: '' });
        this.logger.log(`Cleared access token for ${body.shop_domain}`);
      }
    }
  }

  @Post('orders/updated')
  public async updateOrder(@Body() body: any) {
    this.logger.debug(`Webhook orders/updated received (order ${body?.id})`);
  }

  @Post('orders/create')
  public async createOrder(@Body() body: any) {
    this.logger.debug(`Webhook orders/create received (order ${body?.id})`);
  }

  @Post('products/update')
  public async updateProduct(@Body() body: any) {
    this.logger.debug(`Webhook products/update received (product ${body?.id})`);
  }

  @Post('subscription_billing_attempts/success')
  public async createSubscriptionById(@Body() body: any) {
    this.logger.debug('Webhook subscription_billing_attempts/success received');
  }

  @Post('app_subscriptions/update')
  public async updateSubscriptionById(@Body() body: any, @Req() req: Request) {
    await this.dataService.setPlanState(body.app_subscription);
  }
}
