import {
  CanActivate,
  ExecutionContext,
  Injectable,
  Logger,
  RawBodyRequest,
  UnauthorizedException,
} from '@nestjs/common';
import { createHmac, timingSafeEqual } from 'crypto';
import { ConfigService } from '@nestjs/config';
import { Request, Response } from 'express';
/**
 * HMAC verification guard, used in webhook routes.
 * */
@Injectable()
export class HashVerificationGuard implements CanActivate {
  private readonly logger = new Logger('HashVerificationGuard');
  private readonly api_secret: string;
  constructor(
    private readonly configService: ConfigService,
  ) {
    this.api_secret = configService.get<string>('shopify_api_secret');
  }
  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest();

    const rawRequest = context.switchToHttp().getRequest<RawBodyRequest<Request>>()
    const hmac = request.headers['x-shopify-hmac-sha256'];

    if (!hmac) {
      this.logger.debug('hmac not found');
      throw new UnauthorizedException('Bad Request');
    }
  //console.log(requestBody.rawBody)
    this.logger.debug(`Verifying HMAC verification with secret`);
    const calculatedHmac = createHmac('sha256',  this.api_secret).update(rawRequest.rawBody)
      .digest('base64');

    const a = Buffer.from(calculatedHmac, 'utf8');
    const b = Buffer.from(hmac, 'utf8');
    // timingSafeEqual throws when buffer lengths differ
    if (a.length !== b.length || !timingSafeEqual(a, b)) {
      this.logger.debug('HMAC verification failed');
      throw new UnauthorizedException('Invalid header signature, Bad Request');
    }
    this.logger.debug('HMAC verification successful');
    return true;
  }
}
