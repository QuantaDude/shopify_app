import { createClient, createKeyv, RedisClientType } from '@keyv/redis';
import { Inject, Module, OnApplicationShutdown } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { Cacheable, Keyv } from 'cacheable';
import { CacheService } from './cache.service';
import Client from 'ioredis';
import Redlock from 'redlock';

@Module({
  imports: [ConfigModule],
  providers: [
    {
      provide: 'REDIS_CLIENT',
      useFactory: (config: ConfigService) => {
        const clientType: RedisClientType = createClient({
          // NOTE: the fallback here used to be '6739' (a typo). Redis default is 6379.
          url: `redis://${config.get('redis.host', 'localhost')}:${config.get('redis.port', '6379')}`,
        });
        return createKeyv(clientType);
      },
      inject: [ConfigService],
    },
    {
      provide: 'CACHE_INSTANCE',
      useFactory: (redisClient: Keyv, config: ConfigService) => {
        return new Cacheable({
          primary: redisClient,
          ttl: config.get('cache.ttl', '5m'),
        });
      },
      inject: ['REDIS_CLIENT', ConfigService],
    },
    {
      provide: 'CACHE_LOCK',
      useFactory: (config: ConfigService) => {
        // Redlock needs an ioredis-style client, not the Keyv wrapper.
        const client = new Client({
          host: config.get('redis.host', 'localhost'),
          port: config.get('redis.port', 6379),
          maxRetriesPerRequest: null, // Critical for Redlock
        });
        return new Redlock([client], {
          driftFactor: 0.01,
          retryCount: 2,
          retryDelay: 300,
          retryJitter: 200,
          automaticExtensionThreshold: 0,
        });
      },
      inject: [ConfigService],
    },
    CacheService,
  ],
  exports: ['CACHE_INSTANCE', 'CACHE_LOCK'],
})
export class CacheModule implements OnApplicationShutdown {
  constructor(@Inject('REDIS_CLIENT') private readonly redisClient: Keyv) {}
  async onApplicationShutdown() {
    try {
      await this.redisClient.disconnect();
    } catch (err) {
      console.error('Redis shutdown error', err);
    }
  }
}