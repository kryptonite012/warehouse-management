import { Module } from '@nestjs/common';
import { FulfillmentController } from './fulfillment.controller';
import { FulfillmentService } from './fulfillment.service';

@Module({ controllers: [FulfillmentController], providers: [FulfillmentService], exports: [FulfillmentService] })
export class FulfillmentModule {}
