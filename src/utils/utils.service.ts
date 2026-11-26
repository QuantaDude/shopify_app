import { ShopifyHeaders, ShopifyRequestOptions } from 'src/utils/types/ShopifyRequestOptions';
import { ResponseBodyType, ShopifyResponse } from 'src/utils/types/ShopifyResponse';

import { HttpService } from '@nestjs/axios';
import { firstValueFrom } from 'rxjs';
import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { AxiosHeaders, AxiosRequestConfig, AxiosResponse, Method, ResponseType } from 'axios';
import { Store } from 'src/database/entities/store.entity';
import { Repository } from 'typeorm';
import { InjectRepository } from '@nestjs/typeorm';
import { CsrfProvider } from './providers/csrf.provider';
import { Request, Response } from 'express';
import { GetInstallCodeDto } from 'src/shopify/shopify-auth/dtos/get-code-query.dto';
import { GetInstallInitQueryDto } from 'src/shopify/shopify-auth/dtos/get-install-query.dto';
import * as crypto from 'crypto';
import { Job } from 'bullmq';

/**
 * Here all the utility functions are defined. These are used throughout the app.
 * */
@Injectable()
export class UtilsService {
  private readonly logger = new Logger(UtilsService.name);

  constructor(
    private readonly configService: ConfigService,
    private readonly httpService: HttpService,

    private readonly csrfProvider: CsrfProvider,
    @InjectRepository(Store)
    private storeRepository: Repository<Store>,
  ) {
    //csrfProvider = new CsrfProvider(undefined);
  }
  private isStore = (data: unknown): data is Store => {
    return data instanceof Store || (typeof data === 'object' && data !== null && 'table_id' in data);
  };

  public getStoreByDomain = async (shop: string): Promise<Store> => {
    const existingStore = await this.storeRepository.findOneBy({
      myshopify_domain: shop,
    });
    return existingStore;
  };
  public getAllStoresByDomain = async (shop: string): Promise<Store[]> => {
    let stores: Store[];
    try {
      stores = await this.storeRepository.findBy({ myshopify_domain: shop });
    } catch (error) {
      this.logger.error(error.message, this.getAllStoresByDomain.name);
    }
    return stores;
  };
  public getShopifyURLForStore(endpoint: string, store: Store): string {
    const shopifyApiVersion = this.configService.get<string>('shopify_api_version');

    return this.checkIfStoreIsPrivate(store)
      ? `https://${store.api_key}:${store.api_secret_key}@${store.myshopify_domain}/admin/api/${shopifyApiVersion}/${endpoint}`
      : `https://${store.myshopify_domain}/admin/api/${shopifyApiVersion}/${endpoint}`;
  }

  /**
   * Verifies the `hmac` query parameter of an incoming Shopify request.
   *
   * Per Shopify's documentation the HMAC is computed over the remaining query
   * parameters, sorted alphabetically by key and RFC 3986 percent-encoded
   * (`%`, `&`, `=`, `+`, and reserved characters escaped), joined with `&`.
   * https://shopify.dev/docs/api/usage/authentication#verify-the-hmac-parameter
   */
  public validateRequestFromShopify = async (
    request: GetInstallCodeDto | GetInstallInitQueryDto,
  ): Promise<boolean> => {
    try {
      const hmac = request.hmac;
      if (!hmac) {
        return false;
      }
      const { hmac: _dropped, ...rest } = request as unknown as Record<string, unknown>;

      const entries = Object.entries(rest)
        .filter(([, value]) => value !== undefined && value !== null)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([key, value]) => {
          const encodedKey = this.encodeRFC3986(String(key));
          const encodedValue = this.encodeRFC3986(String(value));
          return `${encodedKey}=${encodedValue}`;
        });
      const str = entries.join('&');

      const verHmac = crypto
        .createHmac('sha256', this.configService.get('shopify_api_secret'))
        .update(str)
        .digest('hex');

      const a = Buffer.from(verHmac, 'utf8');
      const b = Buffer.from(hmac, 'utf8');
      return a.length === b.length && crypto.timingSafeEqual(a, b);
    } catch (error) {
      this.logger.error(error.message, this.validateRequestFromShopify.name);
      return false;
    }
  };

  private encodeRFC3986(value: string): string {
    return encodeURIComponent(value)
      .replace(/[!'()*]/g, c => '%' + c.charCodeAt(0).toString(16).toUpperCase());
  }

  public checkIfStoreIsPrivate(store: Store): boolean {
    if (
      (store['api_key'] == undefined || store.api_key == null) &&
      (store['api_secret_key'] == undefined || store.api_secret_key == null)
    ) {
      return false;
    }
    return (
      'api_key' in store &&
      'api_secret_key' in store &&
      store.api_key !== null &&
      store.api_secret_key !== null &&
      store.api_key.length > 0 &&
      store.api_secret_key.length > 0
    );
  };

  public getShopifyStoreURL(endpoint: string, myshopify_domain: string): string;
  public getShopifyStoreURL(endpoint: string, store: Store): string;
  public getShopifyStoreURL(endpoint: string, domain_or_store: Store | string): string {
    if (this.isStore(domain_or_store)) {
      const store = domain_or_store;
      return this.checkIfStoreIsPrivate(store)
        ? `https://${store.api_key}:${store.api_secret_key}@${store.myshopify_domain}/admin/api/${this.configService.get('shopify_api_version')}/${endpoint}`
        : `https://${store.myshopify_domain}/admin/api/${this.configService.get('shopify_api_version')}/${endpoint}`;
    } else {
      return `https://${domain_or_store}/admin/api/${this.configService.get('shopify_api_version')}/${endpoint}`;
    }
  }

  /**
   * Validates a response from UtilsService.requestToShopify for a GraphQL call and returns its body.
   *
   * requestToShopify already flattens GraphQL responses (respBody = response.data.data), and reports
   * problems through `graphQLErrors`, `error`, `errorMessage` and `statusCode`, never inside respBody.
   * This helper:
   *  - logs the raw response (truncated) to the console and to the BullMQ job's own log
   *  - throws a readable error on GraphQL errors, HTTP/network failures, or an empty body
   */
  public async unwrapGraphQL<T>(response: any, label: string, job?: Job): Promise<T> {
    const dump = JSON.stringify(
      {
        status: response?.statusCode,
        error: response?.error,
        errorMessage: response?.errorMessage,
        graphQLErrors: response?.graphQLErrors,
        body: response?.respBody,
      },
      null,
      2,
    );
    this.logger.debug(`[${label}] ${dump.slice(0, 4000)}`); // truncated, product pages are huge
    await job?.log(`[${label}] ${dump.slice(0, 4000)}`);

    if (response?.graphQLErrors?.length) {
      throw new Error(`Shopify GraphQL errors (${label}): ${JSON.stringify(response.graphQLErrors)}`);
    }
    if (response?.error || (response?.statusCode ?? 0) >= 400) {
      throw new Error(
        `Shopify request failed (${label}): ${response?.statusCode} ${response?.errorMessage ?? dump.slice(0, 1000)}`,
      );
    }
    if (response?.respBody == null) {
      throw new Error(`Empty GraphQL response (${label}): ${dump.slice(0, 1000)}`);
    }
    return response.respBody as T;
  }
  public getGraphQLHeadersForStore = (store: Store): ShopifyHeaders => {
    return this.checkIfStoreIsPrivate(store)
      ? new AxiosHeaders({
        'Content-Type': 'application/json',
        'X-Shopify-Access-Token': store['api_secret_key'],
        'X-GraphQL-Cost-Include-Fields': true,
      })
      : new AxiosHeaders({
        'Content-Type': 'application/json',
        'X-Shopify-Access-Token': store.access_token,
        'X-GraphQL-Cost-Include-Fields': true,
      });
  };
  public isAppEmbedded = (): boolean => {
    return this.configService.get('shopify_app_embedded');
  };

  /**
   * For reqyests where body/data is not required. ShopifyRequestOptions object type is used.
   * Returns ShopifyResponse
   * @param options data is ommited. Refer to ShopifyRequestOptions and ShopifyResponse.
   * @param method The HTTP request method. This tells the server what action needs to be performed with the specified resource. Valid: get, post, delete, put, patch
   * @returns It returns the entire response. The response body is returned in the type specified during the call to this function. If type T is not specified, then response body is of any type and you get no type safety. Note that you will get errors if the returned response differs in key names.
   * */

  public async requestToShopify<T extends ResponseBodyType>(
    method: 'get' | 'delete',
    options: Omit<ShopifyRequestOptions, 'data'>,
  ): Promise<ShopifyResponse<T>>;

  /**
   * For requests where body/data is required. ShopifyRequestOptions object type is used.
   * Returns ShopifyResponse
   * @param options data is included. Refer to ShopifyRequestOptions and ShopifyResponse.
   * @param method The HTTP request method. This tells the server what action needs to be performed with the specified resource. Valid: get, post, delete, put, patch
   * @returns It returns the entire response. The response body is returned in the type specified during the call to this function. If type T is not specified, then response body is of any type and you get no type safety. Note that you will get errors if the returned response differs in key names.
   * */

  public async requestToShopify<T extends ResponseBodyType>(
    method: 'post' | 'put' | 'patch',
    options: ShopifyRequestOptions,
  ): Promise<ShopifyResponse<T>>;

  /**
   *For requests of all method types. It accepts headers, url/endpoint, payload individually.
   * @param headers The headers for the request. Include the required key value pairs.
   * @param payload The data/body that will be sent with the request. It is dropped if the method is either GET or DELETE.
   * @param endpoint The url endpoint to which the request will be sent.
   * @param method The HTTP request method. This tells the server what action needs to be performed with the specified resource. Valid: get, post, delete, put, patch
   * @returns It returns the entire response. The response body is returned in the type specified during the call to this function. If type T is not specified, then response body is of any type and you get no type safety. Note that you will get errors if the returned response differs in key names.
   */

  public async requestToShopify<T extends ResponseBodyType>(
    method: Method,
    endpoint: string,
    headers: ShopifyHeaders,
    payload?: Record<string, any>,
  ): Promise<ShopifyResponse<T>>;

  /**one implementation handles all the overloads
   *
   * */

  public async requestToShopify<T extends ResponseBodyType>(
    method: Method,
    endpointOrOptions: string | ShopifyRequestOptions,
    headers?: ShopifyHeaders,
    payload?: Record<string, any>,
  ): Promise<ShopifyResponse<T>> {
    const reqResult: ShopifyResponse<T> = { status: false, respBody: null as T };

    try {
      let response;
      //handle the first two overloads
      if (typeof endpointOrOptions === 'object') {
        const requestConfig: AxiosRequestConfig = { method: method, ...endpointOrOptions };
        response = await firstValueFrom(this.httpService.request(requestConfig));
      }
      // Handle the calls where the second argument is not an object, that is, the call includes
      // endpoint, headers, payload as separate values.
      else {
        response = await firstValueFrom(
          this.httpService.request({
            method,
            url: endpointOrOptions,
            headers,
            ...(payload && { data: payload }),
          }),
        );
      }

      reqResult.status = true;
      reqResult.respBody = response.data as T;
      reqResult.statusCode = response.status;

      const isGraphQL = typeof endpointOrOptions === 'object' && !!endpointOrOptions.url?.includes('graphql');

      if (isGraphQL && method.toString().toLowerCase() === 'post') {
        const gqlErrors = response.data?.errors;
        if (gqlErrors?.length) {
          // GraphQL reports failures with HTTP 200, so translate them into a status code callers can act on.
          const throttled = gqlErrors.some((e: any) => e?.extensions?.code === 'THROTTLED');
          reqResult.status = false;
          reqResult.statusCode = throttled ? 429 : 400;
          reqResult.graphQLErrors = gqlErrors;
          this.logger.error(JSON.stringify(gqlErrors));
        }
        // Flatten response for GraphQL calls
        reqResult.respBody = (response.data?.data ?? null) as T;
      }
      return reqResult;
    } catch (error) {
      reqResult.error = true;

      if (error.response) {
        // Non-2xx HTTP response: keep Shopify's body and status code.
        reqResult.respBody = error.response.data as T;
        reqResult.statusCode = error.response.status;
      } else {
        // Network error / timeout: do NOT put the message into respBody (it is typed T, not string).
        reqResult.respBody = null as T;
        reqResult.errorMessage = error.message;
      }

      return reqResult;
    }
  }

  public getGenerateTokenfunction = (): Function => {
    return this.csrfProvider.getGenerateToken;
  };

  public generateToken = (req: Request, res: Response): string => {
    //const gentoken: Function = this.csrfProvider.getGenerateToken;

    return this.csrfProvider.generateToken(req, res);
  };

}
