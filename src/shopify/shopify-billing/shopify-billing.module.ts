import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { ConfigModule } from '@nestjs/config';
import { JwtModule } from '@nestjs/jwt';
import { BillingController } from './billing.controller';
import { ShopifyBillingService } from './shopify-billing.service';

import { DataModule } from '../../data/data.module';
import { UtilsModule } from '../../utils/utils.module';
import { AuthModule } from '../../auth/auth.module';
import jwtConfig from '../../auth/config/jwt.config';
import { Store } from '../../database/entities/store.entity';
import { Plan } from '../../database/entities/plans.entity';

@Module({
  imports: [
    DataModule,
    UtilsModule,
    AuthModule,
    TypeOrmModule.forFeature([Store, Plan]),
    // Dependencies of the AccessTokenGuard this controller uses.
    ConfigModule.forFeature(jwtConfig),
    JwtModule.registerAsync(jwtConfig.asProvider()),
  ],
  controllers: [BillingController],
  providers: [ShopifyBillingService],
})
export class ShopifyBillingModule {}
