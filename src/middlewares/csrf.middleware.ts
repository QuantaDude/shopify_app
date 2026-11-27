import { Injectable, NestMiddleware } from '@nestjs/common';
import { NextFunction, Request, Response } from 'express';
import { CsrfProvider } from '../utils/providers/csrf.provider';

/**
 * Applies CSRF validation to state-changing requests.
 *
 * All of the configuration (secret, cookie, token sources) lives in CsrfProvider,
 * which is the same instance used to mint tokens for the views, so a token
 * generated on one page is always validatable here.
 *
 * Route notes:
 *  - Safe methods (GET/HEAD/OPTIONS) are skipped by the library itself, so no
 *    per-route special cases are needed for page rendering.
 *  - POST /login is exempted in AppModule (the login page cannot carry a token yet),
 *    and /shopify/* routes (OAuth + webhooks) are excluded there as well.
 * */
@Injectable()
export class CsrfMiddleware implements NestMiddleware {
  constructor(private readonly csrfProvider: CsrfProvider) {}

  use(req: Request, res: Response, next: NextFunction) {
    this.csrfProvider.protect(req, res, next);
  }
}
