import { Processor, WorkerHost } from '@nestjs/bullmq';
import { JOB_TYPES, JobRegistry, QUEUES } from '../constants/jobs.constants';
import { Job, UnrecoverableError } from 'bullmq';
import { Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Store } from 'src/database/entities/store.entity';
import { Repository } from 'typeorm';
import { UtilsService } from 'src/utils/utils.service';
import { ConfigService } from '@nestjs/config';
import { ShopifyResponse } from 'src/utils/types/ShopifyResponse';
import { ShopifyRequestOptions } from 'src/utils/types/ShopifyRequestOptions';
import {
  WebhookSubscriptionCreateDocument,
  WebhookSubscriptionFormat,
  WebhookSubscriptionTopic,
} from 'src/generated/graphql';
import { print } from 'graphql';

type ConfigureJobNames = typeof JOB_TYPES.CONFIGURE_WEBHOOKS;

type ConfigureJobs = {
  [K in ConfigureJobNames]: Job<JobRegistry[K]['data'], JobRegistry[K]['result']> & { name: K };
}[ConfigureJobNames];
@Processor(QUEUES.CONFIGURE, { concurrency: 10 })
export class ConfigWebhookConsumer extends WorkerHost {
  constructor(
    private readonly configService: ConfigService,
    private readonly utilsService: UtilsService,
    @InjectRepository(Store)
    private readonly storesRepository: Repository<Store>,
  ) {
    super();
  }

  private readonly logger = new Logger(ConfigWebhookConsumer.name);

  private readonly webhookSubscriptionCreateMutation: string = print(WebhookSubscriptionCreateDocument);

  /**
   * 'orders/create' (REST topic string) -> 'ORDERS_CREATE' (GraphQL enum)
   */
  private toWebhookTopicTopic(topic: string): WebhookSubscriptionTopic {
    return topic.replace(/\//g, '_').toUpperCase() as WebhookSubscriptionTopic;
  }

  public process = async (job: ConfigureJobs): Promise<JobRegistry[typeof JOB_TYPES.CONFIGURE_WEBHOOKS]['result']> => {
    const storeId = job.data.storeId;

    const store = await this.storesRepository.findOneBy({ table_id: storeId });
    if (!store) {
      throw new UnrecoverableError(`Store ${storeId} not found`);
    }

    const requestOptions: ShopifyRequestOptions = {
      // REST Admin API is legacy: create webhooks through the GraphQL API
      url: this.utilsService.getShopifyURLForStore('graphql.json', store),
      headers: this.utilsService.getGraphQLHeadersForStore(store),
    };

    const webhooks_config: string[] = this.configService.get('webhooks');
    for (const element of webhooks_config) {
      requestOptions.data = {
        query: this.webhookSubscriptionCreateMutation,
        variables: {
          topic: this.toWebhookTopicTopic(element),
          webhookSubscription: {
            uri: this.configService.get<string>('app_url') + `/shopify/webhook/${element}`,
            format: WebhookSubscriptionFormat.Json,
          },
        },
      };

      const response: ShopifyResponse = await this.utilsService.requestToShopify('post', requestOptions);
      if (response.error || (response.statusCode ?? 0) >= 400) {
        // One topic failing should fail the job so BullMQ retries the whole configuration.
        this.logger.error(
          `Webhook subscription for topic ${element} failed: ${response.statusCode} ${response.errorMessage ?? ''}`,
        );
        throw new Error(
          `Webhook subscription for topic ${element} failed: ${response.statusCode} ${response.errorMessage ?? ''}`,
        );
      }
      this.logger.debug(`Response for topic ${element} : ${JSON.stringify(response.respBody)}`);
    }
  };
}
