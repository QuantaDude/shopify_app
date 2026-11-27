import { InjectQueue } from '@nestjs/bullmq';
import { Injectable, Logger, OnApplicationShutdown } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JobsOptions, Queue, QueueEvents } from 'bullmq';
import {
  AUTH_REQUIRED_REASON,
  errorResult,
  JOB_TYPES,
  JobRegistry,
  jobToQueueMap,
  JobType,
  QueueData,
  QueueName,
  QueueResult,
  QUEUES,
} from './constants/jobs.constants';
import { Store } from 'src/database/entities/store.entity';
import { RegisterUserDto } from 'src/web-app/dtos/register-member.dto';
import { newProductDto } from 'src/web-app/dtos/new-product.dto';
import { Cron, CronExpression, Interval } from '@nestjs/schedule';
import { StoreLocations } from 'src/database/entities/storeLocations.entity';

/** Default time addJob waits for a job before reporting it as PENDING. */
const DEFAULT_WAIT_MS = 30_000;

/**
 *This Service exposes all the functions required to launch tasks in worker threads.
 * */
@Injectable()
export class JobsService implements OnApplicationShutdown {
  private readonly logger = new Logger(JobsService.name);
  /**
   * A key value pair variable that is used by the addJob function to add a job to the correct queue instance.
   * */
  private queues: Record<QueueName, Queue>;

  /**
   * To instance and store all the QueueEvent objects required to detect when the job is finished.
   * */
  private queueEventsMap: Record<string, QueueEvents> = {};

  constructor(
    private readonly configService: ConfigService,

    @InjectQueue('PAUSED_QUEUE')
    private pausedQueue: Queue,
    @InjectQueue(QUEUES.CRON)
    private cronQueue: Queue<QueueData<typeof QUEUES.CRON>, QueueResult<typeof QUEUES.CRON>>,
    @InjectQueue(QUEUES.CONFIGURE)
    private configQueue: Queue<QueueData<typeof QUEUES.CONFIGURE>, QueueResult<typeof QUEUES.CONFIGURE>>,
    @InjectQueue(QUEUES.PRODUCTS)
    private productQueue: Queue<QueueData<typeof QUEUES.PRODUCTS>, QueueResult<typeof QUEUES.PRODUCTS>>,
    @InjectQueue(QUEUES.ORDERS)
    private ordersQueue: Queue<QueueData<typeof QUEUES.ORDERS>, QueueResult<typeof QUEUES.ORDERS>>,
    @InjectQueue(QUEUES.CUSTOMERS)
    private customersQueue: Queue<QueueData<typeof QUEUES.CUSTOMERS>, QueueResult<typeof QUEUES.CUSTOMERS>>,
    @InjectQueue(QUEUES.STORES)
    private storesQueue: Queue<QueueData<typeof QUEUES.STORES>, QueueResult<typeof QUEUES.STORES>>,
    @InjectQueue(QUEUES.USERS)
    private usersQueue: Queue<QueueData<typeof QUEUES.USERS>, QueueResult<typeof QUEUES.USERS>>,

  ) {
    this.queues = {
      [QUEUES.PRODUCTS]: this.productQueue,
      [QUEUES.CONFIGURE]: this.configQueue,
      [QUEUES.ORDERS]: this.ordersQueue,
      [QUEUES.USERS]: this.usersQueue,
      [QUEUES.STORES]: this.storesQueue,
      [QUEUES.CUSTOMERS]: this.customersQueue,

      [QUEUES.CRON]: this.cronQueue,
    };

    // Initialize queue events. QueueEvents opens its own Redis connection, so it
    // must get the same connection options as the queues (the default is
    // 127.0.0.1:6379, which silently breaks remote Redis deployments).
    const connection = {
      host: this.configService.get<string>('redis.host'),
      port: this.configService.get<number>('redis.port'),
    };
    Object.keys(this.queues).forEach(queueName => {
      this.queueEventsMap[queueName] = new QueueEvents(queueName, { connection });
    });
  }

  /** Closes the extra Redis connections opened by the QueueEvents listeners. */
  async onApplicationShutdown(): Promise<void> {
    await Promise.allSettled(Object.values(this.queueEventsMap).map(events => events.close()));
  }
  /**
   * A single function to add any valid job to it's respective queue.
   *
   * Outcomes:
   *  - the job's regular result when it finishes within the wait window
   *  - `{ status: 'AUTH_REQUIRED' }` when the consumer marked the job 401 (store must re-auth);
   *    the job is also recorded in the PAUSED_QUEUE so it can be resumed after re-auth
   *  - `{ status: 'PENDING', jobId }` when the job is still running past the wait timeout
   *    (sync of a large store legitimately takes longer than the timeout — this is NOT a failure)
   *  - any other failure is rethrown so the caller sees the real error instead of `undefined`
   *
   * @param type Any Job which is a key in JobRegistry.
   * @param data data which is of the type defined in the JobRegistry.
   * @param opts optional parameter, can also be used to manually set jobId, priority of a job, delay, parent Job
   * @param shopDomain the shop's myshopify domain; required to pause/resume AUTH_REQUIRED jobs per store
   * @param waitMs how long to wait for the result before reporting PENDING (default 30s)
   * */
  async addJob<T extends JobType>(
    type: T,
    data: JobRegistry[T]['data'],
    opts: JobsOptions = { attempts: 3, backoff: { delay: 5000, type: 'exponential' } },
    shopDomain?: string,
    waitMs: number = DEFAULT_WAIT_MS,
  ): Promise<JobRegistry[T]['result'] | errorResult> {
    const queueName = jobToQueueMap[type];
    const queue = this.queues[queueName];
    const event = this.queueEventsMap[queueName];
    const job = await queue.add(type, data, opts);
    try {
      const result = await job.waitUntilFinished(event, waitMs);
      return result as JobRegistry[T]['result'];
    } catch (error) {
      if (error.message === AUTH_REQUIRED_REASON || job.failedReason === AUTH_REQUIRED_REASON) {
        // The consumer hit a 401: the store's access token is stale. Park the job
        // in the PAUSED_QUEUE (keyed by shop domain) so resumePausedJobsForStore
        // can re-run it after the merchant re-authenticates.
        if (job.name != JOB_TYPES.BUY_STORE_PLAN && shopDomain) {
          await this.pausedQueue.add(
            job.queueName + ':' + shopDomain + ':' + type,
            { queue: job.queueName, jobName: job.name, id: job.id, task_type: type },
            { jobId: shopDomain },
          );
        }
        return { status: 'AUTH_REQUIRED', shopDomain } as errorResult;
      }
      // A timeout is not a failure: the job keeps running in the worker.
      if (error.name === 'TimeoutError' || /timed?\s?out/i.test(error.message ?? '')) {
        this.logger.warn(`Job ${type} (${job.id}) still running after ${waitMs}ms — reporting as PENDING`);
        return { status: 'PENDING', jobId: job.id };
      }
      // Real failures must not masquerade as `undefined` (success) anymore.
      this.logger.error(
        `Job ${type} (${job.id}) failed: ${error.message}`,
        error.stack,
        this.addJob.name,
      );
      throw error;
    }
  }
  public configure = async (storeId: number) => await this.addJob(JOB_TYPES.CONFIGURE_WEBHOOKS, { storeId: storeId });
  public syncProducts = async (storeId: number, shopDomain?: string): Promise<boolean | errorResult> =>
    await this.addJob(JOB_TYPES.SYNC_PRODUCTS, { storeId: storeId }, undefined, shopDomain);
  public getProducts = async (store: Store | number) => await this.addJob(JOB_TYPES.GET_PRODUCTS, { store: store });
  public syncOrders = async (storeId: number, shopDomain?: string): Promise<boolean | errorResult> =>
    await this.addJob(JOB_TYPES.SYNC_ORDERS, { storeId: storeId }, undefined, shopDomain);
  public getOrders = async (storeId: number) => await this.addJob(JOB_TYPES.GET_ORDERS, { storeId: storeId });
  public getOrder = async (orderId: number) => await this.addJob(JOB_TYPES.GET_ORDER, { orderId: orderId });
  public syncCustomers = async (storeId: number, shopDomain?: string): Promise<boolean | errorResult> =>
    await this.addJob(JOB_TYPES.SYNC_CUSTOMERS, { storeId: storeId }, undefined, shopDomain);
  public getCustomers = async (storeId: number) => this.addJob(JOB_TYPES.GET_CUSTOMERS, { storeId: storeId });
  public getStore = async (storeId: number) => await this.addJob(JOB_TYPES.GET_STORE, { storeId: storeId });

  public syncStoreLocations = async (
    storeId: number,
    shopDomain?: string,
  ): Promise<StoreLocations[] | null | errorResult> =>
    await this.addJob(JOB_TYPES.SYNC_STORE_LOCATIONS, { storeId: storeId }, undefined, shopDomain);

  public getStoreLocations = async (storeId: number) =>
    await this.addJob(JOB_TYPES.GET_STORE_LOCATIONS, { storeId: storeId });

  public getMembers = async (storeId: number) => await this.addJob(JOB_TYPES.GET_USERS, { storeId: storeId });

  public getAllStoresForUser = async (userId: number) =>
    await this.addJob(JOB_TYPES.GET_STORES_FOR_USER, { userId: userId });

  public createMember = async (newMember: RegisterUserDto, storeId: number) =>
    await this.addJob(JOB_TYPES.CREATE_USER, { user: newMember, storeId: storeId });

  public createProduct = async (storeId: number, product: newProductDto, shopDomain?: string) =>
    await this.addJob(JOB_TYPES.CREATE_PRODUCT, { product: product, storeId: storeId }, undefined, shopDomain, 60_000);

  public syncProductTypes = async (storeId: number) =>
    await this.addJob(JOB_TYPES.SYNC_PRODUCT_TYPES, { storeId: storeId });
  public getProductTypes = async (id?: string) => await this.addJob(JOB_TYPES.GET_PRODUCT_TYPES, { id: id });

  public getProductTypesNames = async (level: number) =>
    await this.addJob(JOB_TYPES.GET_PRODUCT_TYPE_NAMES, { level: level });

  public cacheProductTypes = async () => await this.addJob(JOB_TYPES.CACHE_PRODUCT_TYPES, null);

  public activateTrial = async (storeId: number, userId: number) =>
    await this.addJob(JOB_TYPES.ACTIVATE_TRIAL, { storeId: storeId, userId: userId });
  public buyPlan = async (planId: number, userId: number, storeId: number) =>
    await this.addJob(JOB_TYPES.BUY_STORE_PLAN, { storeId: storeId, planId: planId, userId: userId });

  /**
   * After a store re-authenticates (fresh access token already saved to the DB),
   * re-run the job that was parked in the PAUSED_QUEUE for that shop domain.
   *
   * Job data only carries the store table_id and consumers always load the store
   * fresh from the DB, so resuming is just moving the original failed job back to
   * the wait state — no job-data patching or lock juggling needed.
   */
  public resumePausedJobsForStore = async (store_domain: string): Promise<boolean> => {
    try {
      const pausedJob = await this.pausedQueue.getJob(store_domain);
      if (!pausedJob) {
        this.logger.warn(`No paused job found for ${store_domain}`);
        return false;
      }
      const { queue: queueName, id: jobId } = pausedJob.data as { queue: QueueName; id: string };
      const queue = this.queues[queueName];
      if (!queue) {
        this.logger.warn(`Paused job references unknown queue ${queueName}`);
        return false;
      }
      const job = await queue.getJob(jobId);
      if (!job) {
        this.logger.warn(`Paused job ${jobId} no longer exists in queue ${queueName}`);
        await this.pausedQueue.remove(store_domain);
        return false;
      }
      await job.retry('failed');
      await this.pausedQueue.remove(store_domain);
      this.logger.log(`Resumed ${job.name} (${jobId}) for ${store_domain}`);
      return true;
    } catch (error) {
      this.logger.error(error.message, error.stack, this.resumePausedJobsForStore.name);
      return false;
    }
  };

  /**
   * Registers (or updates) a Job Scheduler for a recurring job.
   *
   * BullMQ 6 removed the legacy `repeat` job option; recurring work is now
   * expressed as Job Schedulers (`upsertJobScheduler`). The scheduler produces
   * jobs named after `type`, so existing consumers keep working unchanged.
   */
  public async upsertJobScheduler<T extends JobType>(
    type: T,
    rule: { pattern: string; tz?: string },
    jobTemplate: { data?: JobRegistry[T]['data']; opts?: JobsOptions } = {},
  ): Promise<void> {
    const queueName = jobToQueueMap[type];
    const queue = this.queues[queueName];
    if (!queue) {
      throw new Error(`No queue registered for job type ${type}`);
    }
    // Jobs produced by the scheduler are named after `type`, so the
    // consumers' `switch (job.name)` keeps matching.
    await queue.upsertJobScheduler(type, rule, {
      name: type,
      data: jobTemplate.data,
      opts: jobTemplate.opts,
    });
    this.logger.log(`Job scheduler upserted: ${type} (${rule.pattern})`);
  }


}
