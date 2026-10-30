import { Global, Module } from '@nestjs/common';
import { CustomersModule } from '../customers/customers.module';
import { OrderStateService } from '../orders/order-state.service';
import { OrdersController, StorefrontController } from '../orders/orders.controller';
import { OrdersService } from '../orders/orders.service';
import { StoreAllocationService } from '../orders/store-allocation.service';
import { StorefrontService } from '../orders/storefront.service';
import { PaymentGateway } from '../payments/gateway';
import { PaymentsController } from '../payments/payments.controller';
import { PaymentsService } from '../payments/payments.service';

/** Orders and payments share the order state machine, so they live in one module. */
@Global()
@Module({
  imports: [CustomersModule],
  controllers: [StorefrontController, OrdersController, PaymentsController],
  providers: [OrderStateService, StoreAllocationService, StorefrontService, OrdersService, PaymentGateway, PaymentsService],
  exports: [OrderStateService, OrdersService, PaymentsService, StoreAllocationService],
})
export class CommerceModule {}
