import { MiddlewareConsumer, Module, NestModule } from '@nestjs/common';
import { APP_FILTER, APP_GUARD } from '@nestjs/core';
import { ThrottlerGuard, ThrottlerModule } from '@nestjs/throttler';
import { AuthGuard } from './common/auth.guard';
import { CommonModule } from './common/common.module';
import { RedisThrottlerStorage } from './common/redis-throttler.storage';
import { GlobalExceptionFilter } from './common/errors';
import { RequestIdMiddleware } from './common/request-id.middleware';
import { MetricsMiddleware, OpsController } from './metrics';
import { AuthModule } from './modules/auth/auth.module';
import { OrganizationModule } from './modules/organization/organization.module';
import { UsersModule } from './modules/users/users.module';
import { WarehousesModule } from './modules/warehouses/warehouses.module';
import { CatalogModule } from './modules/catalog/catalog.module';
import { InventoryModule } from './modules/inventory/inventory.module';
import { ProcurementModule } from './modules/procurement/procurement.module';
import { CommerceModule } from './modules/commerce/commerce.module';
import { FulfillmentModule } from './modules/fulfillment/fulfillment.module';
import { DeliveryModule } from './modules/delivery/delivery.module';
import { ReportsModule } from './modules/reports/reports.module';
import { GovernanceModule } from './modules/governance/governance.module';
import { SyncModule } from './modules/sync/sync.module';
import { IntelligenceModule } from './modules/intelligence/intelligence.module';

@Module({
  imports: [
    ThrottlerModule.forRoot({
      throttlers: [{ ttl: 60_000, limit: Number(process.env.RATE_LIMIT_PER_MINUTE ?? 600) }],
      storage: process.env.REDIS_URL ? new RedisThrottlerStorage(process.env.REDIS_URL) : undefined,
    }),
    CommonModule,
    AuthModule,
    UsersModule,
    OrganizationModule,
    WarehousesModule,
    CatalogModule,
    InventoryModule,
    ProcurementModule,
    CommerceModule,
    FulfillmentModule,
    DeliveryModule,
    ReportsModule,
    GovernanceModule,
    SyncModule,
    IntelligenceModule,
  ],
  controllers: [OpsController],
  providers: [
    { provide: APP_GUARD, useClass: ThrottlerGuard },
    { provide: APP_GUARD, useClass: AuthGuard },
    { provide: APP_FILTER, useClass: GlobalExceptionFilter },
  ],
})
export class AppModule implements NestModule {
  configure(consumer: MiddlewareConsumer) {
    consumer.apply(RequestIdMiddleware, MetricsMiddleware).forRoutes('*');
  }
}
