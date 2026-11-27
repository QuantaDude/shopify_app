import { Controller, Get, Logger, Query, Res, UnauthorizedException, UseGuards } from '@nestjs/common';
import { Response } from 'express';
import { AccessTokenGuard } from '../../auth/guards/access-token.guard';
import { DataService } from '../../data/data.service';
import { ShopifyBillingService } from './shopify-billing.service';
import { BillingDto } from './billing.dto';

/**
 * Return URL Shopify sends the merchant's browser to after they approve (or
 * decline) an app subscription charge.
 *
 * This route used to be fully unauthenticated and trusted planId / userId /
 * storeId straight from the query string, which allowed anyone to craft a URL
 * granting an arbitrary plan to an arbitrary store. It now requires a logged-in
 * session AND verifies the charge against Shopify's subscription state before
 * applying anything.
 * */
@UseGuards(AccessTokenGuard)
@Controller()
export class BillingController {
  private readonly logger = new Logger(BillingController.name);

  constructor(
    private readonly dataService: DataService,
    private readonly billingService: ShopifyBillingService,
  ) {}

  @Get()
  public async acceptSubscription(@Query() query: BillingDto, @Res() res: Response) {
    // Verify the charge against Shopify's own subscription state before
    // applying anything: the returnUrl's planId/userId/storeId come from the
    // browser and cannot be trusted on their own.
    const verification = await this.billingService.verifyCharge(query.storeId, query.charge_id);

    if (!verification.verified) {
      this.logger.warn(
        `Rejected billing return for store ${query.storeId}, charge ${query.charge_id}: ${verification.reason}`,
      );
      throw new UnauthorizedException('Charge could not be verified');
    }

    await this.dataService.setPlan(query.planId, query.userId, query.storeId, query.charge_id.toString());
    await this.dataService.setPendingSubs(query.charge_id.toString(), '0');
    res.redirect('/billing');
  }
}
