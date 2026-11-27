import { Processor, WorkerHost } from '@nestjs/bullmq';
import { AUTH_REQUIRED_REASON, JOB_TYPES, JobRegistry, QUEUES } from '../constants/jobs.constants';
import { Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Store } from 'src/database/entities/store.entity';
import { Repository } from 'typeorm';
import { ConfigService } from '@nestjs/config';
import { UtilsService } from 'src/utils/utils.service';
import { Customer } from 'src/database/entities/customer.entity';
import { Job, UnrecoverableError } from 'bullmq';
import { ShopifyRequestOptions } from 'src/utils/types/ShopifyRequestOptions';
import { ShopifyResponse } from 'src/utils/types/ShopifyResponse';
import { TokenExpiredException } from '../token-expired.exception';

interface PageInfo {
  hasNextPage: boolean;
  endCursor: string;
  hasPreviousPage: boolean;
  startCursor: string;
}

type CustomersJobNames = typeof JOB_TYPES.SYNC_CUSTOMERS | typeof JOB_TYPES.GET_CUSTOMERS;

type CustomerQueueJob = {
  [K in CustomersJobNames]: Job<JobRegistry[K]['data'], JobRegistry[K]['result']> & { name: K };
}[CustomersJobNames];
@Processor(QUEUES.CUSTOMERS, { concurrency: 10 })
export class CustomersConsumer extends WorkerHost {
  private readonly logger = new Logger(CustomersConsumer.name);

  constructor(
    private readonly configService: ConfigService,
    private readonly utilsService: UtilsService,

    @InjectRepository(Customer)
    private readonly customersRepository: Repository<Customer>,
    @InjectRepository(Store)
    private readonly storesRepository: Repository<Store>,
  ) {
    super();
  }

  public process = async (job: CustomerQueueJob): Promise<JobRegistry[CustomersJobNames]['result']> => {
    try {
      switch (job.name) {
        case JOB_TYPES.SYNC_CUSTOMERS:
          return await this.syncCustomers(job.data, job);
        case JOB_TYPES.GET_CUSTOMERS:
          return await this.retrieveCustomers(job.data);

        default:
          throw Error('Invalid job');
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

  private retrieveCustomers = async (
    data: JobRegistry[typeof JOB_TYPES.GET_CUSTOMERS]['data'],
  ): Promise<JobRegistry[typeof JOB_TYPES.GET_CUSTOMERS]['result']> => {
    let customers: Customer[] | Customer;
    try {
      customers = await this.customersRepository.findBy({
        store_id: data.storeId,
      });
    } catch (error) {
      this.logger.error(error.message, '', this.retrieveCustomers.name);
      return null;
    }
    return customers;
  };

  private syncCustomers = async (
    data: JobRegistry[typeof JOB_TYPES.SYNC_CUSTOMERS]['data'],
    job: Job,
  ): Promise<JobRegistry[typeof JOB_TYPES.SYNC_CUSTOMERS]['result']> => {
    const store = await this.loadStore(data.storeId);
    const options: ShopifyRequestOptions = {
      url: this.utilsService.getShopifyURLForStore('graphql.json', store),
      headers: this.utilsService.getGraphQLHeadersForStore(store),
    };

    let cursor: string | null = null;

    do {
      options.data = this.getQueryObjectForCustomers(cursor);
      const response: ShopifyResponse = await this.utilsService.requestToShopify('post', options);

      if (response.statusCode == 401) {
        throw new TokenExpiredException(`Token expired for ${store.table_id}`, {
          shop: store.table_id.toString(),
          jobId: job.id,
        });
      }

      // Throws on GraphQL errors, HTTP/network failures (incl. 429 throttling) and empty bodies.
      const body = await this.utilsService.unwrapGraphQL<{
        customers: { edges: any[]; pageInfo: PageInfo };
      }>(response, 'syncCustomers', job);

      await this.storeCustomersDB(store.table_id, body.customers.edges);
      cursor = this.getCursorFromResponse(body.customers.pageInfo);
    } while (cursor !== null);

    return true;
  };

  private getCursorFromResponse = (pageInfo: PageInfo): string | null => {
    try {
      return pageInfo.hasNextPage === true ? pageInfo.endCursor : null;
    } catch (error) {
      this.logger.debug(error.message, this.getCursorFromResponse.name);
      return null;
    }
  };

  private storeCustomersDB = async (storeId: number, customers: any): Promise<Customer[] | Customer | null> => {
    let customersCreated: Customer | Customer[];
    try {
      if (!customers || !Array.isArray(customers) || customers.length === 0) {
        return;
      }

      const formattedCustomers = customers.map(node => {
        const customer = node.node;
        return {
          id: this.extractId(customer.id),
          store_id: storeId,
          email: customer.email,
          first_name: customer.firstName,
          last_name: customer.lastName,
          phone: customer.phone,
          tags: customer.tags.join(','),
          created_at: customer.createdAt,
          updated_at: customer.updatedAt,
          default_address: customer.defaultAddress,
          // 2026-10: the consent objects were replaced by state scalars
          accepts_marketing: customer.smsMarketingConsent ?? customer.emailMarketingConsent,

          orders_count: 0,
          currency: 'Rupees',
          admin_graphql_api_id: customer.id,
        };
      });
      customersCreated = this.customersRepository.create(formattedCustomers);
      await this.customersRepository.upsert(formattedCustomers, ['id', 'store_id']);
      /* await this.customersRepository
         .createQueryBuilder()
         .insert()
         .into(Customer)
         .values(formattedCustomers)
         .orUpdate(
           [
             'email',
             'first_name',
             'last_name',
             'created_at',
             'updated_at',
             'tags',
             'phone',
             'default_address',
             'accepts_marketing',
           ],
           ['id', 'store_id'],
         )
         .execute();
     */
    } catch (error) {
      this.logger.error(error.message, error.stack);
      return null;
    }

    return customersCreated;
  };

  private extractId = (gidString: string): number | null => {
    const regex = /gid:\/\/shopify\/\w+\/(\d+)/;
    const match = gidString.match(regex);

    // match contains the entire original string, match[index] contain the groups of numbers
    if (match && match[1]) {
      return parseInt(match[1], 10);
    }

    return null;
  };
  //type predicate guard
  private isStore = (store: Store | number): store is Store => {
    //typecast
    return (store as Store).table_id !== undefined;
  };

  private getQueryObjectForCustomers = (cursor: string | null): { query: string } | null => {
    try {
      const filter = `(first: 5${cursor ? `, after: "${cursor}"` : ''})`;

      const query = `{
                customers${filter} {
                    edges {
                        node {
                            id
                            email
                            firstName
                            lastName
                            phone
                            tags
                            createdAt
                            updatedAt
                            displayName
                            note
                            verifiedEmail
                            taxExempt
                            defaultAddress {
                                id
                                address1
                                city
                                country
                                phone
                                province
                                zip
                            }
                            metafields(first: 5) {
                                edges {
                                    node {
                                        id
                                        key
                                        value
                                        namespace
                                        description
                                    }
                                }
                            }
                            // 2026-10: consent fields are state scalars now,
                            // they no longer have sub-fields
                            smsMarketingConsent
                            emailMarketingConsent
                        }
                    }
                    pageInfo {
                        hasNextPage
                        endCursor
                        hasPreviousPage
                        startCursor
                    }
                }
            }`;

      return { query };
    } catch (error) {
      this.logger.error(error.message, this.getQueryObjectForCustomers.name);
      return null;
    }
  };
}
