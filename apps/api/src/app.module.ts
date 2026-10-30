import { MiddlewareConsumer, Module, NestModule } from '@nestjs/common';
import { APP_FILTER, APP_GUARD } from '@nestjs/core';
import { ThrottlerGuard, ThrottlerModule } from '@nestjs/throttler';
import { AuthGuard } from './common/auth.guard';
import { CommonModule } from './common/common.module';
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

@Module({
  imports: [
    ThrottlerModule.forRoot([{ ttl: 60_000, limit: Number(process.env.RATE_LIMIT_PER_MINUTE ?? 600) }]),
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
