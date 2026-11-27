import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { doubleCsrf, DoubleCsrfConfigOptions, DoubleCsrfUtilities } from 'csrf-csrf';
import { NextFunction, Request, Response } from 'express';

/**
 * Single owner of the CSRF (double-csrf) configuration.
 *
 * Both sides of the flow delegate to this one instance:
 *  - CsrfMiddleware validates incoming state-changing requests
 *  - UtilsService.generateToken mints the tokens embedded in views
 *
 * Previously the middleware and the provider each created their own
 * `doubleCsrf()` instance with drifted options (sameSite 'strict' vs 'lax'),
 * which only worked by accident because both read the same secret.
 * */
@Injectable()
export class CsrfProvider {
  private readonly utilities: DoubleCsrfUtilities;

  constructor(private readonly configService: ConfigService) {
    const secret = this.configService.get<string>('csrf_secret');
    if (!secret) {
      // Fail fast: without the secret every generated/validated token would
      // HMAC against undefined and all POSTs would 500/403.
      throw new Error('CSRF_SECRET is not set — check your .env / .env.development file.');
    }

    const config: DoubleCsrfConfigOptions = {
      getSecret: () => secret,
      cookieName: 'x-csrf-token',
      cookieOptions: {
        httpOnly: true,
        // 'lax' (not 'strict'): OAuth and Shopify billing redirects land on
        // our pages as top-level GET navigations; 'strict' would drop the
        // cookie on exactly those flows and break the app right after install.
        sameSite: 'lax',
        secure: process.env.NODE_ENV === 'production',
        path: '/',
      },
      size: 64,
      getCsrfTokenFromRequest: req => req.headers['x-csrf-token'],
      getSessionIdentifier: req =>
        (req.headers['access_token'] ?? req.cookies?.['access_token']) as string,
      errorConfig: {
        statusCode: 403,
        message: 'Invalid CSRF Token',
        code: 'EBADCSRFTOKEN',
      },
    };

    this.utilities = doubleCsrf(config);
  }

  /** Mints a fresh CSRF token (and sets the matching httpOnly cookie). */
  generateToken = (req: Request, res: Response): string => {
    return this.utilities.generateCsrfToken(req, res);
  };

  /** Validates the token/cookie pair for state-changing requests; skips safe methods. */
  protect = (req: Request, res: Response, next: NextFunction): void => {
    this.utilities.doubleCsrfProtection(req, res, next);
  };
}
