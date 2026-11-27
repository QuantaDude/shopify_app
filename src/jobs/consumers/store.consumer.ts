import { Processor, WorkerHost } from '@nestjs/bullmq';
import { AUTH_REQUIRED_REASON, JOB_TYPES, JobRegistry, QUEUES } from '../constants/jobs.constants';
import { Store } from 'src/database/entities/store.entity';
import { Inject, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { QueryRunner, Repository, UpdateResult } from 'typeorm';
import { Job, UnrecoverableError } from 'bullmq';
import { StoreLocations } from 'src/database/entities/storeLocations.entity';
import { ShopifyRequestOptions } from 'src/utils/types/ShopifyRequestOptions';
import { UtilsService } from 'src/utils/utils.service';
import { ShopifyResponse } from 'src/utils/types/ShopifyResponse';
import { AxiosHeaders } from 'axios';
import { ConfigService } from '@nestjs/config';
import { TokenExpiredException } from '../token-expired.exception';
import { print } from 'graphql';
import {
  AppSubscriptionCreateDocument,
  AppSubscriptionCreateMutation,
  AppSubscriptionCreateMutationVariables,
  CurrencyCode,
  GetShopLocationsDocument,
  GetShopLocationsQuery,
} from '../../generated/graphql';
import { DataService } from '../../data/data.service';
import { Plan } from '../../database/entities/plans.entity';
import { StorePlan } from '../../database/entities/storePlans.entity';
import { CacheService } from '../../data/cache/cache.service';
import Redlock from 'redlock';

type StoreJobNames =
  | typeof JOB_TYPES.GET_STORE
  | typeof JOB_TYPES.SYNC_STORE
  | typeof JOB_TYPES.SYNC_STORES
  | typeof JOB_TYPES.GET_STORE_LOCATIONS
  | typeof JOB_TYPES.SYNC_STORE_LOCATIONS
  | typeof JOB_TYPES.UPDATE_STORE_TOKEN
  | typeof JOB_TYPES.BUY_STORE_PLAN
  | typeof JOB_TYPES.ACTIVATE_TRIAL;

type StoreJobs = {
  [K in StoreJobNames]: Job<JobRegistry[K]['data'], JobRegistry[K]['result']> & { name: K };
}[StoreJobNames];

@Processor(QUEUES.STORES, { concurrency: 10 })
export class StoresConsumer extends WorkerHost {
  private readonly logger = new Logger(StoresConsumer.name);

  private readonly appSubscriptionCreateMutation: string = print(AppSubscriptionCreateDocument);
  private readonly syncShopLocationsQuery: string = print(GetShopLocationsDocument);
  constructor(
    private readonly cacheService: CacheService,
    @Inject('CACHE_LOCK') private readonly redLock: Redlock,

    @InjectRepository(Store)
    private readonly storesRepository: Repository<Store>,
    @InjectRepository(StorePlan)
    private readonly storePlansRepository: Repository<StorePlan>,
    @InjectRepository(StoreLocations)
    private readonly locationsRepository: Repository<StoreLocations>,

    private readonly utilsService: UtilsService,
    private readonly configService: ConfigService,
    private readonly dataService: DataService,
  ) {
    super();
  }
  public process = async (job: StoreJobs): Promise<JobRegistry[StoreJobNames]['result']> => {
    try {
      switch (job.name) {
        case JOB_TYPES.GET_STORE:
          return await this.retrieveStore(job.data);
        case JOB_TYPES.SYNC_STORES:
          return await this.syncStores();
        case JOB_TYPES.SYNC_STORE:
          return await this.syncStore(job.data);
        case JOB_TYPES.GET_STORE_LOCATIONS:
          return await this.retrieveStoreLocations(job.data);
        case JOB_TYPES.SYNC_STORE_LOCATIONS:
          return await this.syncStoreLocations(job.data, job);
        case JOB_TYPES.UPDATE_STORE_TOKEN:
          return await this.updateStoreToken(job.data);
        case JOB_TYPES.BUY_STORE_PLAN:
          return await this.buyPlan(job.data);
        case JOB_TYPES.ACTIVATE_TRIAL:
          return await this.activateTrialForStore(job.data);
        default:
          throw new Error('Invalid job');
      }
    } catch (error) {
      this.logger.error(error.message, error.stack);

      // A stale access token is not retryable until the merchant re-authenticates.
      // The fixed '401' failedReason is what JobsService.addJob matches AUTH_REQUIRED on.
      if (error['isTokenExpired']) {
        throw new UnrecoverableError(AUTH_REQUIRED_REASON);
      }
      throw error;
    }
  };

  /**
   * Job data only carries the store table_id (no access tokens in Redis),
   * so every Shopify-backed handler loads the store fresh from the DB.
   */
  private loadStore = async (storeId: number): Promise<Store> => {
    const store = await this.storesRepository.findOneBy({ table_id: storeId });
    if (!store) {
      throw new UnrecoverableError(`Store ${storeId} not found`);
    }
    return store;
  };
  /**
  private isJobOfType<T extends keyof JobRegistry>(
    job: Job<JobRegistry[keyof JobTypeMap]['data'], JobTypeMap[keyof JobTypeMap]['result']>,
    name: T,
  ): job is Job<JobTypeMap[T]['data'], JobTypeMap[T]['result']> {
    return job.name === name;
  }
*/
  private syncStores = async (): Promise<void> => {
    let queryRunner: QueryRunner;
    try {
      // TypeORM 1.x: `manager.connection` was renamed to `manager.dataSource`
      queryRunner = this.storePlansRepository.manager.dataSource.createQueryRunner();
      await queryRunner.connect();
      await queryRunner.startTransaction();
      const storesToSync = await this.cacheService.get<Array<number>>('credits-keys');
      if (!Array.isArray(storesToSync) || storesToSync.length === 0) {
        return;
      }
      const stores = await this.storePlansRepository
        .createQueryBuilder('store_plan')
        .where('store_plan.store_id IN (:...storeIds)', { storeIds: storesToSync })
        .getMany();

      for (const store of stores) {
        const lock = await this.dataService.getStoreCreditsLock(store.store_id);
        if (lock == undefined) {
          continue;
        }

        const currentCredits = await this.cacheService.get<number>(`${store.store_id}-credits`);
        store.credits = currentCredits;
        const updatedStore = await queryRunner.manager.save(store);
        await lock.release();
      }
      await queryRunner.commitTransaction();
    } catch (err) {
      await queryRunner.rollbackTransaction();
      throw err;
    } finally {
      await queryRunner.release();
    }
  };

  private buyPlan = async (
    data: JobRegistry[typeof JOB_TYPES.BUY_STORE_PLAN]['data'],
  ): Promise<JobRegistry[typeof JOB_TYPES.BUY_STORE_PLAN]['result']> => {
    const store = await this.loadStore(data.storeId);
    const plans = await this.dataService.getPlans();

    const selectedPlan: Plan = plans.find(plan => plan.id == data.planId);
    if (!selectedPlan) {
      throw new UnrecoverableError(`Plan ${data.planId} not found`);
    }
    if (selectedPlan.name == 'Trial' || selectedPlan.name == 'Demo' || selectedPlan.name == 'Free') {
      return this.configService.get('app_url') + '/billing';
    }
    const options: ShopifyRequestOptions = {
      url: this.utilsService.getShopifyURLForStore('graphql.json', store),
      headers: this.utilsService.getGraphQLHeadersForStore(store),
    };
    const variables: AppSubscriptionCreateMutationVariables = {
      name: selectedPlan.name,
      returnUrl:
        this.configService.get<string>('app_url') +
        `/shopify/rac?planId=${selectedPlan.id}&userId=${data.userId}&storeId=${store.id}`,
      // Only dev stores accept test charges; toggle with BILLING_TEST_MODE
      test: this.configService.get<boolean>('billing_test_mode') ?? true,
      lineItems: {
        plan: {
          appRecurringPricingDetails: {
            price: {
              amount: selectedPlan.price,
              currencyCode: CurrencyCode.Usd,
            },
          },
        },
      },
    };
    options.data = {
      query: this.appSubscriptionCreateMutation,
      variables: { ...variables },
    };

    const response = await this.utilsService.requestToShopify<AppSubscriptionCreateMutation>('post', options);

    if (response.statusCode === 401) {
      // Oauth failed, token expired
      throw new TokenExpiredException(`Token expired for ${store.table_id}`, {
        shop: store.table_id.toString(),
        jobId: '',
      });
    }

    // Throws on GraphQL errors, HTTP/network failures (incl. 429 throttling) and empty bodies.
    const body = await this.utilsService.unwrapGraphQL<AppSubscriptionCreateMutation>(
      response,
      'appSubscriptionCreate',
    );

    if (body.appSubscriptionCreate?.userErrors?.length) {
      // Deterministic failure — retrying the same subscription create will not help.
      throw new UnrecoverableError(
        `appSubscriptionCreate userErrors: ${JSON.stringify(body.appSubscriptionCreate.userErrors)}`,
      );
    }

    const url: string = body.appSubscriptionCreate?.confirmationUrl;
    if (!url) {
      throw new Error(
        `appSubscriptionCreate returned no confirmationUrl: ${JSON.stringify(body.appSubscriptionCreate)}`,
      );
    }
    // Redirect to the confirmation shopify page
    return url;
  };
  private activateTrialForStore = async (
    data: JobRegistry[typeof JOB_TYPES.ACTIVATE_TRIAL]['data'],
  ): Promise<JobRegistry[typeof JOB_TYPES.ACTIVATE_TRIAL]['result']> => {
    const store = await this.loadStore(data.storeId);
    // setPlan(planId=1, userId, storeId) — 1 is the Trial plan; store.id is the
    // Shopify numeric id the StorePlan table is keyed by.
    await this.dataService.setPlan(1, data.userId, store.id);
    return true;
  };
  private retrieveStore = async (
    data: JobRegistry[typeof JOB_TYPES.GET_STORE]['data'],
  ): Promise<JobRegistry[typeof JOB_TYPES.GET_STORE]['result']> => {
    //let storeId;

    try {
      //typeof job.data === 'number' ? storeId = job.data : null;

      const store: Store = await this.storesRepository.findOneBy({
        table_id: data.storeId,
      });
      if (store !== undefined) {
        return store;
      }
    } catch (error) {
      this.logger.error(error.message, error.stack);
    }

    return null;
  };
  private updateStoreToken = async (
    data: JobRegistry[typeof JOB_TYPES.UPDATE_STORE_TOKEN]['data'],
  ): Promise<JobRegistry[typeof JOB_TYPES.UPDATE_STORE_TOKEN]['result']> => {
    const { storeId, accessToken } = data;
    const store = await this.storesRepository.findOneBy({ table_id: storeId });
    if (!store) {
      return false;
    }

    const updatedEntry: UpdateResult = await this.storesRepository.update(
      { table_id: store.table_id },
      { access_token: accessToken },
    );

    return updatedEntry.affected && updatedEntry.affected > 0;
  };
  private syncStore = async (
    data: JobRegistry[typeof JOB_TYPES.SYNC_STORE]['data'],
  ): Promise<JobRegistry[typeof JOB_TYPES.SYNC_STORE]['result']> => {
    try {
    } catch (error) {
      this.logger.error(error.message, error.stack);
      return null;
    }
  };
  private retrieveStoreLocations = async (
    data: JobRegistry[typeof JOB_TYPES.GET_STORE_LOCATIONS]['data'],
  ): Promise<JobRegistry[typeof JOB_TYPES.GET_STORE_LOCATIONS]['result']> => {
    try {
      return await this.locationsRepository.findBy({ store_id: data.storeId });
    } catch (error) {
      this.logger.error(error.message, this.retrieveStoreLocations.name);
      return null;
    }
  };

  private syncStoreLocationsPayload(after?: string | null) {
    return {
      query: this.syncShopLocationsQuery,
      variables: { after: after ?? null }
    }
  }
  private syncStoreLocations = async (
    data: JobRegistry[typeof JOB_TYPES.SYNC_STORE_LOCATIONS]['data'],
    job: Job,
  ): Promise<JobRegistry[typeof JOB_TYPES.SYNC_STORE_LOCATIONS]['result']> => {
    const locations: StoreLocations[] = [];
    const store: Store = await this.loadStore(data.storeId);

    const options: ShopifyRequestOptions = {
      url: this.utilsService.getShopifyURLForStore('graphql.json', store),
      headers: this.utilsService.getGraphQLHeadersForStore(store),
    };

    // Follow pagination to fetch every location page
    let cursor: string | null = null;
    do {
      options.data = this.syncStoreLocationsPayload(cursor);
      const response: ShopifyResponse = await this.utilsService.requestToShopify('post', options);

      // The 401 check must run before unwrapGraphQL: unwrap would throw a plain
      // Error for the 401 status, losing the TokenExpiredException marker.
      if (response.statusCode === 401) {
        throw new TokenExpiredException(`Token expired for ${store.table_id}`, {
          shop: store.table_id.toString(),
          jobId: job.id,
        });
      }

      // Throws on GraphQL errors, HTTP/network failures (incl. 429 throttling) and empty bodies.
      const body = await this.utilsService.unwrapGraphQL<GetShopLocationsQuery>(
        response,
        `location(${cursor ?? 0})`,
      );

      const result: StoreLocations[] = await this.saveStoreLocations(
        body.locations.edges ?? [],
        store.table_id,
      );
      locations.push(...result);
      const pageInfo = body.locations.pageInfo;
      cursor = pageInfo.hasNextPage ? pageInfo.endCursor : null;
    } while (cursor !== null);

    return locations;
  };
  private extractIdFromGraphQLId(graphqlId: string, prefix?: string): number | null {
    try {
      if (!graphqlId) {
        return null;
      }

      const idPart = prefix ? graphqlId.replace(`gid://shopify/${prefix}/`, '') : graphqlId;

      return parseInt(idPart, 10);
    } catch (error) {
      this.logger.error(`Failed to extract ID from ${graphqlId}: ${error.message}`, error.stack);
      return null;
    }
  }

  private saveStoreLocations = async (locations: object[], storeId: number): Promise<StoreLocations[]> => {
    const returnData: Array<StoreLocations> = [];
    const payload: Array<StoreLocations> = [];
    //console.log(locations[0]);
    for (const data of locations) {
      const loc = data['node'];

      const location = {
        id: this.extractIdFromGraphQLId(loc['id'], 'Location'),
        store_id: storeId,
        name: loc['name'],
        address1: loc['address']['address1'],
        address2: loc['address']['address2'],
        city: loc['address']['city'],
        zip: loc['address']['zip'],
        province: loc['address']['province'],
        country: loc['address']['country'],
        phone: loc['address']['phone'],
        created_at: loc['createdAt'],
        updated_at: loc['updatedAt'],
        country_code: loc['address']['countryCode'],
        province_code: loc['address']['provinceCode'],
        country_name: loc['address']['country'],
        active: loc['isActive'],
        localized_country_name: loc['address']['country'],
        localized_province_name: loc['address']['province'],
      };
      if (await this.locationsRepository.existsBy({ id: location.id })) {
        await this.locationsRepository.update({ id: location.id }, location);

        returnData.push(location as StoreLocations);
        continue;
      }

      //console.log(location);
      payload.push(location as StoreLocations);
    }
    let save = this.locationsRepository.create(payload);
    save = await this.locationsRepository.save(save);
    returnData.push(...save);
    return returnData;
  };
  private isStore = (data: unknown): data is Store => {
    return data instanceof Store || (typeof data === 'object' && data !== null && 'table_id' in data);
  };

  private isAccessTokenValid = async (storeDetails: Store): Promise<boolean> => {
    try {
      if (storeDetails.access_token.length > 0) {
        // REST Admin API is legacy: verify the token with a minimal GraphQL query
        const options: ShopifyRequestOptions = {
          url: this.utilsService.getShopifyURLForStore('graphql.json', storeDetails),
          headers: new AxiosHeaders()
            .set('Content-Type', 'application/json')
            .set('X-Shopify-Access-Token', storeDetails.access_token),
          data: { query: '{ shop { id } }' },
        };

        const response: ShopifyResponse = await this.utilsService.requestToShopify('post', options);

        return response.statusCode === 200;
      }
      throw new Error(`Access token for the store ${storeDetails.name} is not present`);
    } catch (error) {
      //log
      this.logger.error(`Failed to verify access token for the Shopify store. \n ${error}`);
      return false;
    }
  };
}
