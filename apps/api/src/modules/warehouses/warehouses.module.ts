import { Module } from '@nestjs/common';
import { StorePerformanceService } from './store-performance.service';
import { WarehousesController } from './warehouses.controller';
import { WarehousesService } from './warehouses.service';

@Module({ controllers: [WarehousesController], providers: [WarehousesService, StorePerformanceService], exports: [WarehousesService] })
export class WarehousesModule {}
