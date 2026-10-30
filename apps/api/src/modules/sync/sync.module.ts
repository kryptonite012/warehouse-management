import { Module } from '@nestjs/common';
import { FulfillmentModule } from '../fulfillment/fulfillment.module';
import { SyncController } from './sync.controller';
import { SyncService } from './sync.service';

@Module({ imports: [FulfillmentModule], controllers: [SyncController], providers: [SyncService] })
export class SyncModule {}
