import { Inject, Injectable, Logger, OnApplicationBootstrap } from '@nestjs/common';
import { DataService } from './data/data.service';
import { JobsService } from './jobs/jobs.service';
import { CacheService } from './data/cache/cache.service';
import { JOB_TYPES } from './jobs/constants/jobs.constants';
import { CronExpression } from '@nestjs/schedule';

@Injectable()
export class StartupService implements OnApplicationBootstrap {
  private readonly logger = new Logger(StartupService.name);

  constructor(
    private readonly cacheService: CacheService,
    private readonly jobsService: JobsService,
  ) { }

  onApplicationBootstrap() {
    this.runStartupTask();
  }

  private async runStartupTask() {
    try {
      //cache the product categories to redis cache if they exist in DB and have not been cached before.
      this.cacheService.get<boolean>('productCategorySyncStatus').then(value => {

        if (value == false || value == null || value == undefined) {
          //this.jobsService.cacheProductTypes();
          this.jobsService.addJob(JOB_TYPES.CACHE_PRODUCT_TYPES, null);
        }
      });

      // Recurring jobs are Job Schedulers since BullMQ 6 (the legacy
      // `repeat` job option was removed in v6).
      // CHECK_PENDING_PAYMENTS used to run every 5 seconds, which flooded the
      // queue with ~17k retained jobs per day; once a minute is plenty (the
      // internal attempt counter only queries Shopify every 3rd run).
      this.jobsService.upsertJobScheduler(
        JOB_TYPES.CHECK_PENDING_PAYMENTS,
        { pattern: CronExpression.EVERY_MINUTE },
        { data: {}, opts: { attempts: 1, backoff: { delay: 1000, type: 'exponential' } } },
      );

      this.jobsService.upsertJobScheduler(
        JOB_TYPES.SYNC_STORES,
        { pattern: CronExpression.EVERY_MINUTE },
        { data: {}, opts: { attempts: 3, backoff: { delay: 5000, type: 'exponential' } } },
      );

      //stub store to fetch product types from shopify
      const store = await this.jobsService.getStore(1);
      if (store && store != null && 'table_id' in store) {
        this.jobsService.addJob(JOB_TYPES.SYNC_PRODUCT_TYPES, { storeId: store.table_id });
        // will not sync if the stub store's access token is not an offline token and has expired.
        this.jobsService.upsertJobScheduler(
          JOB_TYPES.SYNC_PRODUCT_TYPES,
          { pattern: CronExpression.EVERY_2_HOURS },
          { data: { storeId: store.table_id }, opts: { attempts: 3, backoff: { delay: 5000, type: 'exponential' } } },
        );
      } else {
        this.logger.warn(
          'The SUPER ADMIN/ stub store does not exist. A super admin has to manually start the sync of product types.',
        );
      }
      this.logger.log('Startup tasks initiated.');
    } catch (error) {
      this.logger.error(`Startup task failed: ${error.message}`, error.stack);
    }
  }
}
