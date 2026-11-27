import { Controller, Get, Logger, Query, Req, Res, UnauthorizedException, UseFilters } from '@nestjs/common';
import { ShopifyAuthService } from './shopify-auth.service';
import { UtilsService } from 'src/utils/utils.service';
import { ConfigService } from '@nestjs/config';
import { GetInstallInitQueryDto } from './dtos/get-install-query.dto';
import { GetInstallCodeDto } from './dtos/get-code-query.dto';
import { UnauthorizedExceptionFilter } from '../../filters/hmac.exception.filter';
import { JobsService } from 'src/jobs/jobs.service';
import { Store } from '../../database/entities/store.entity';
import { Response, Request } from 'express';
/**
 * These routes need to be allowed in the shopify app's configuration
 * */
@Controller() //@Controller('/shopify/auth')
@UseFilters(UnauthorizedExceptionFilter)
export class ShopifyAuthController {
  private readonly logger: Logger = new Logger(ShopifyAuthController.name);

  private clientId: string;
  private accessScopes: string;
  private redirectUri: string;

  constructor(
    private readonly installationService: ShopifyAuthService,
    private readonly utilsService: UtilsService,
    private readonly configService: ConfigService,
    private readonly jobsService: JobsService,
  ) {
    this.clientId = configService.get('shopify_api_key');
    this.accessScopes = configService.get('shopify_api_scopes');
    this.redirectUri = configService.get('app_install_URL');
  }

  /**
   *Initial route that shopify sends request to when a store owner wants to install the app.
   *It checks if the store already exists in the database or not. If not, it redirects to /shopify/auth/redirect to carry out the installation.
   * */
  @Get('/')
  public async startInstallation(
    @Req() request: Request,
    @Query() query: GetInstallInitQueryDto,
    @Res() response: Response,
  ) {
    try {
      const shop: string = query.shop;
      //const endpoint = `https://${shop}/admin/oauth/authorize?client_id=${this.clientId}&scope=${this.accessScopes}&redirect_uri=${this.redirectUri}`;
      const validRequest: boolean = await this.utilsService.validateRequestFromShopify(query);
      if (validRequest) {
        //check query.shop if it is made optional, or according to the global Validation config
        const storeDetails: Store = await this.utilsService.getStoreByDomain(query.shop);
        if (storeDetails !== null && storeDetails.myshopify_domain == query.shop) {
          //store exists in the app's DB
          const validToken: boolean = await this.installationService.isAccessTokenValid(storeDetails);
          if (validToken) {
            // const store: Store = await this.jobsService.updateStore(storeDetails);
            const isEmbedded: boolean = this.utilsService.isAppEmbedded();
            if (isEmbedded) {
              //handle embedded apps
            } else {
              response.redirect('/');
            }
          } else {
            const endpoint: string = await this.installationService.getOAuthURL(this.clientId, shop);
            return response.redirect(endpoint);
          }
        } else {
          const url: string = await this.installationService.getOAuthURL(this.clientId, shop);
          // The nonce is stored server-side (Redis, single-use, TTL'd) inside
          // getOAuthURL; no client-side cookie needed.
          return response.redirect(303, url);
        }
      } else {
        this.logger.warn(`HMAC isn't from Shopify`);

        throw new UnauthorizedException({
          status: 401,
          error: 'Unauthorized',
          message: 'Invalid HMAC signature',
          details: {
            reason: 'HMAC verification failed',
            //requestId: 'xyz123' //  include request tracking
          },
        });
      }
    } catch (error) {
      if (error instanceof UnauthorizedException) {
        throw error;
      }
      this.logger.error(error.message, error.stack, this.startInstallation.name);
      throw new UnauthorizedException({
        status: 401,
        error: 'Unauthorized',
        message: 'Installation could not be started',
      });
    }
  }
  @Get('/redirect')
  public async install(@Req() request: Request, @Query() query: GetInstallCodeDto, @Res() response: Response) {
    try {
      const validateHMAC: boolean = await this.utilsService.validateRequestFromShopify(query);
      // The nonce previously "did not work" because the cache stack silently
      // expired every TTL'd key (the @keyv/redis adapter expected absolute epoch
      // ms while keyv passed relative TTLs); with that fixed the nonce check is
      // reliable again.
      const validateNonce: boolean = await this.installationService.validateNonce(query.state, query.shop);

      if (!validateHMAC) {
        this.logger.warn(`HMAC isn't from Shopify`);
        throw new UnauthorizedException({
          status: 401,
          error: 'Unauthorized',
          message: 'Invalid HMAC signature',
          details: {
            reason: 'HMAC verification failed',
          },
        });
      }
      if (!validateNonce) {
        this.logger.warn(`Nonce validation failed for ${query.shop}`);
        throw new UnauthorizedException({
          status: 401,
          error: 'Unauthorized',
          message: 'Invalid Nonce',
        });
      }

      const shop: string = query.shop;
      const code: string = query.code;

      const accessToken = await this.installationService.getAccessTokenForStore(shop, code);
      if (accessToken != false && accessToken.length > 0) {
        const shopDetails = await this.installationService.getShopDetailsFromShopify(shop, accessToken);
        const storeToDB = await this.installationService.saveStoreDetails(shopDetails.shop, accessToken);

        if (storeToDB.success) {
          this.logger.log(
            `App succesfully installed for store ${shopDetails.shop.myshopifyDomain} and stored to the Database.`,
          );

          const isEmbedded = this.utilsService.isAppEmbedded();

          if (isEmbedded) {
            //handle embedded apps
          } else {
            return response.redirect('/');
          }
        } else {
          //failed to store all details in DB
          this.logger.error(
            `Failed to store installed store ${shop} to the Database.`,
            undefined,
            this.install.name,
          );
        }
      } else {
        this.logger.debug(
          `Installation failed. Failed to retrieve access token for code ${code} and shop domain ${shop}.`,
        );
        throw new UnauthorizedException({
          status: 401,
          error: 'Unauthorized',
          message: 'Invalid code or shop domain',
          details: {
            reason: 'failed to retrieve access token for the specified store',
          },
        });
      }
    } catch (error) {
      if (error instanceof UnauthorizedException) {
        throw error;
      }
      this.logger.error(error.message, error.stack, this.install.name);
      throw new UnauthorizedException({
        status: 401,
        error: 'Unauthorized',
        message: 'Installation failed',
      });
    }
  }
  /**
   * I use this route to re authenticate the access token for a store when a query to shopify return 401 error code.
   * */
  @Get('/updateStoreToken')
  public async updateToken(@Req() request: Request, @Res() response: Response, @Query() query: GetInstallCodeDto) {
    try {
      const validateHMAC: boolean = await this.utilsService.validateRequestFromShopify(query);
      const validateNonce: boolean = await this.installationService.validateNonce(query.state, query.shop);

      if (!validateHMAC) {
        this.logger.warn(`HMAC isn't from Shopify`);
        throw new UnauthorizedException({
          status: 401,
          error: 'Unauthorized',
          message: 'Invalid HMAC signature',
        });
      }
      if (!validateNonce) {
        this.logger.warn(`Nonce validation failed for ${query.shop}`);
        throw new UnauthorizedException({
          status: 401,
          error: 'Unauthorized',
          message: 'Invalid Nonce',
        });
      }

      const shop: string = query.shop;
      const code: string = query.code;
      const accessToken = await this.installationService.getAccessTokenForStore(shop, code);
      if (accessToken != false && accessToken.length > 0) {
        const stores: Store[] = await this.utilsService.getAllStoresByDomain(shop);

        if (stores.length > 0) {
          let store: number = stores[0].id;
          if (stores.length > 1) {
            store = parseInt(
              (await this.installationService.getShopDetailsFromShopify(shop, accessToken)).shop.id.split('/').pop(),
              10,
            );
          }
          const updateAccessToken = await this.installationService.updateAccessToken(store, accessToken);
          if (updateAccessToken) {
            // The new token is already persisted; consumers re-read it from the DB,
            // so resuming just re-runs the parked failed job.
            await this.jobsService.resumePausedJobsForStore(shop);
          }
          response.redirect('/dashboard');
        } else {
          //store doesn't exist in DB
          this.logger.warn(`Re-auth requested for unknown store ${shop}`);
          response.redirect('/');
        }
      }
    } catch (error) {
      if (error instanceof UnauthorizedException) {
        throw error;
      }
      this.logger.error(error.message, error.stack, this.updateToken.name);
      response.redirect('/dashboard');
    }
  }
}
