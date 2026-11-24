import { Module } from '@nestjs/common';
import { WebhooksController } from './webhooks.controller';
import { DataModule } from '../../data/data.module';
import { TypeOrmModule } from '@nestjs/typeorm';
import { Store } from 'src/database/entities/store.entity';

@Module({
  imports: [DataModule, TypeOrmModule.forFeature([Store])],
  controllers: [WebhooksController],
})
export class ShopifyWebhooksModule { }
