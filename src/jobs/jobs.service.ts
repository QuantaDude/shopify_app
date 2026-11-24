import { InjectQueue } from '@nestjs/bullmq';
import { Injectable, Logger } from '@nestjs/common';
import { Job, JobsOptions, Queue, QueueEvents } from 'bullmq';
import {
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
import { User } from '../database/entities/user.entity';
import { Cron, CronExpression, Interval } from '@nestjs/schedule';

/**
 *This Service exposes all the functions required to launch tasks in worker threads.
 * */
@Injectable()
export class JobsService {
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

    // Initialize queue events
    Object.keys(this.queues).forEach(queueName => {
      this.queueEventsMap[queueName] = new QueueEvents(queueName);
    });
  }
  /**
   * A single function to add any valid job to it's respective queue.
   * @param type Any Job which is a key in JobRegistry.
   * @param data data which is of the type defined in the JobRegistry.
   * @param opts optional parameter, can also be used to manually set jobId, priority of a job, delay, parent Job
   * */
  async addJob<T extends JobType>(
    type: T,
    data: JobRegistry[T]['data'],
    opts: JobsOptions = { attempts: 3, backoff: { delay: 5000, type: 'exponential'  } },
  ): Promise<JobRegistry[T]['result']> {
    const queueName = jobToQueueMap[type];
    const queue = this.queues[queueName];
    const event = this.queueEventsMap[queueName];
    const job = await queue.add(type, data, opts);
    try {
      const result = await job.waitUntilFinished(event, 30000);
      return result as JobRegistry[T]['result'];
    } catch (error) {
      if (error.message == '401' || job.failedReason == '401') {
        // Since the SYNC_PRODUCT_TYPES is mainly a background/cron job, we don't add it to pause queue
        if (job.name != JOB_TYPES.BUY_STORE_PLAN && job.data['store']?.myshopify_domain) {
          await this.pausedQueue.add(
            job.queueName + ':' + job.data['store'].myshopify_domain + ':' + type,
            { queue: job.queueName, jobName: job.name, id: job.id, task_type: type },
            { jobId: job.data['store']['myshopify_domain'] },
          );
        }
        return {
          status: 'AUTH_REQUIRED',
          // previously read a non-existent key, so shopDomain was always undefined
          shopDomain: job.data['store']?.myshopify_domain,
        } as errorResult;
      }
      this.logger.debug(JSON.stringify(error) + JSON.stringify(job.data));
    }
  }
  public configure = async (storeId: number) => await this.addJob(JOB_TYPES.CONFIGURE_WEBHOOKS, { storeId: storeId });
  public syncProducts = async (store: Store) : Promise<boolean | errorResult> => await this.addJob(JOB_TYPES.SYNC_PRODUCTS, { store: store });
  public getProducts = async (store: Store | number) => await this.addJob(JOB_TYPES.GET_PRODUCTS, { store: store });
  public syncOrders = async (store: Store) => await this.addJob(JOB_TYPES.SYNC_ORDERS, { store: store });
  public getOrders = async (store: number) => await this.addJob(JOB_TYPES.GET_ORDERS, { storeId: store });
  public getOrder = async (orderId: number) => await this.addJob(JOB_TYPES.GET_ORDER, { orderId: orderId });
  public syncCustomers = async (store: Store) => await this.addJob(JOB_TYPES.SYNC_CUSTOMERS, { store: store });
  public getCustomers = async (store: number) => this.addJob(JOB_TYPES.GET_CUSTOMERS, { storeId: store });
  public getStore = async (storeId: number) => this.addJob(JOB_TYPES.GET_STORE, { storeId: storeId });

  public updateStoreToken = async (store: Store, accessToken: string) =>
    await this.addJob(JOB_TYPES.UPDATE_STORE_TOKEN, { store: store, accessToken: accessToken });

  public syncStoreLocations = async (store: Store) =>
    await this.addJob(JOB_TYPES.SYNC_STORE_LOCATIONS, { store: store });

  public getStoreLocations = async (storeId: number) =>
    await this.addJob(JOB_TYPES.GET_STORE_LOCATIONS, { storeId: storeId });

  public getMembers = async (storeId: number) => await this.addJob(JOB_TYPES.GET_USERS, { storeId: storeId });

  public getAllStoresForUser = async (userId: number) =>
    await this.addJob(JOB_TYPES.GET_STORES_FOR_USER, { userId: userId });

  public createMember = async (newMember: RegisterUserDto, storeId: number) =>
    await this.addJob(JOB_TYPES.CREATE_USER, { user: newMember, storeId: storeId });

  public createProduct = async (store: Store, product: newProductDto) =>
    await this.addJob(JOB_TYPES.CREATE_PRODUCT, { product: product, store: store });

  public syncProductTypes = async (store: Store) => await this.addJob(JOB_TYPES.SYNC_PRODUCT_TYPES, { store: store });
  public getProductTypes = async (id?: string) => await this.addJob(JOB_TYPES.GET_PRODUCT_TYPES, { id: id });

  public getProductTypesNames = async (level: number) =>
    await this.addJob(JOB_TYPES.GET_PRODUCT_TYPE_NAMES, { level: level });

  public cacheProductTypes = async () => await this.addJob(JOB_TYPES.CACHE_PRODUCT_TYPES, null);

  public activateTrial = async (store: Store, user: User) =>
    await this.addJob(JOB_TYPES.ACTIVATE_TRIAL, { store: store, user: user });
  public buyPlan = async (planId: number, userId: number, store: Store) =>
    await this.addJob(JOB_TYPES.BUY_STORE_PLAN, { store: store, planId: planId, userId: userId });

  public resumePausedJobsForStore = async (store_domain: string, accssToken: string) => {
    try {
      const pausedJob = await this.pausedQueue.getJob(store_domain);
      const requiredId = pausedJob.data.id;
      const queueName = pausedJob.data.queue;
      let job: Job;
      switch (queueName) {
        case QUEUES.PRODUCTS:
          job = await this.productQueue.getJob(requiredId);
          break;
        case QUEUES.ORDERS:
          job = await this.ordersQueue.getJob(requiredId);
          break;
        case QUEUES.STORES:
          job = await this.storesQueue.getJob(requiredId);
          break;
      }
      //const job = await this.productQueue.getJob(requiredId);
      job.data['store']['access_token'] = accssToken;
      await job.updateData(job.data);

      await job.extendLock(job.token, 10000);

      await job.retry('failed');
      await this.pausedQueue.remove(store_domain);
    } catch (error) {
      this.logger.error(error.message, error.stack, this.resumePausedJobsForStore.name);
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
