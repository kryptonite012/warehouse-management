import { Global, Module } from '@nestjs/common';
import { InventoryController } from './inventory.controller';
import { InventoryService } from './inventory.service';
import { LedgerService } from './ledger.service';
import { ReservationService } from './reservation.service';

@Global()
@Module({
  controllers: [InventoryController],
  providers: [LedgerService, ReservationService, InventoryService],
  exports: [LedgerService, ReservationService, InventoryService],
})
export class InventoryModule {}
