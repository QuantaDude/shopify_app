import { Catch, ArgumentsHost, ExceptionFilter, HttpException } from '@nestjs/common';
import { BaseExceptionFilter } from '@nestjs/core';
import { Response } from 'express';

/**
 * Formats CSRF failures (from the double-csrf library) as clean 403 responses.
 *
 * Registered globally (APP_FILTER in AppModule) because CSRF errors surface
 * from the middleware layer as well as from controller handlers.
 * */
@Catch(HttpException)
export class CsrfExceptionFilter extends BaseExceptionFilter {
  catch(exception: any, host: ArgumentsHost) {
    const ctx = host.switchToHttp();
    const response = ctx.getResponse<Response>();

    // csrf-csrf marks its errors with code EBADCSRFTOKEN.
    if (exception?.code === 'EBADCSRFTOKEN') {
      return response.status(403).json({
        statusCode: 403,
        message: 'Invalid CSRF token',
        error: 'Forbidden',
      });
    }

    // When no cookie-parser is registered (e.g. in tests) the library throws
    // a TypeError reading its cookie; that is still a CSRF failure, not a 500.
    if (exception instanceof TypeError && /x-csrf-token|csrf/i.test(exception?.message ?? '')) {
      return response.status(403).json({
        statusCode: 403,
        message: 'CSRF token not found',
        error: 'Forbidden',
      });
    }

    super.catch(exception, host);
  }
}
