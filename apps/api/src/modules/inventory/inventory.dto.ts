import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  ArrayMinSize, IsArray, IsBoolean, IsEnum, IsInt, IsOptional, IsString, IsUUID, Length, Min, NotEquals, ValidateNested,
} from 'class-validator';
import { PageQuery } from '../../common/pagination';

export class InventoryQuery extends PageQuery {
  @IsOptional() @IsUUID() warehouseId?: string;
  @IsOptional() @IsUUID() skuId?: string;
  @IsOptional() @IsEnum(['LOW', 'OUT', 'IN']) stock?: 'LOW' | 'OUT' | 'IN';
}

export class MovementQuery extends PageQuery {
  @IsOptional() @IsUUID() warehouseId?: string;
  @IsOptional() @IsUUID() skuId?: string;
  @IsOptional() @IsString() movementType?: string;
  @IsOptional() @IsString() referenceId?: string;
}

export class ReserveItemDto {
  @ApiProperty() @IsUUID() skuId: string;
  @ApiProperty() @IsInt() @Min(1) quantity: number;
}

export class CreateReservationDto {
  @ApiProperty() @IsUUID() warehouseId: string;
  @ApiProperty({ type: [ReserveItemDto] }) @IsArray() @ArrayMinSize(1) @ValidateNested({ each: true }) @Type(() => ReserveItemDto)
  items: ReserveItemDto[];
  @ApiProperty() @IsString() @Length(8, 100) idempotencyKey: string;
  @ApiPropertyOptional() @IsOptional() @IsInt() @Min(1) ttlMinutes?: number;
}

export const ADJUSTABLE_BUCKETS = ['AVAILABLE', 'DAMAGED', 'QUARANTINED', 'EXPIRED'] as const;

export class CreateAdjustmentDto {
  @ApiProperty() @IsUUID() warehouseId: string;
  @ApiProperty() @IsUUID() batchId: string;
  @ApiProperty({ enum: ADJUSTABLE_BUCKETS }) @IsEnum(ADJUSTABLE_BUCKETS) bucket: (typeof ADJUSTABLE_BUCKETS)[number];
  @ApiProperty({ description: 'Positive adds stock, negative removes it' }) @IsInt() @NotEquals(0) quantityDelta: number;
  @ApiProperty({ enum: ['FOUND', 'LOST', 'THEFT', 'DATA_CORRECTION', 'WRITE_OFF', 'DAMAGE_WRITE_OFF', 'EXPIRY_WRITE_OFF'] })
  @IsEnum(['FOUND', 'LOST', 'THEFT', 'DATA_CORRECTION', 'WRITE_OFF', 'DAMAGE_WRITE_OFF', 'EXPIRY_WRITE_OFF']) reasonCode: string;
  @ApiPropertyOptional() @IsOptional() @IsString() @Length(0, 500) notes?: string;
}

export class DecisionDto {
  @ApiProperty() @IsBoolean() approve: boolean;
  @ApiPropertyOptional() @IsOptional() @IsString() notes?: string;
}

export class StatusChangeDto {
  @ApiProperty() @IsUUID() batchId: string;
  @ApiProperty({ enum: ['DAMAGE', 'QUARANTINE', 'QUARANTINE_RELEASE', 'QUARANTINE_TO_DAMAGED'] })
  @IsEnum(['DAMAGE', 'QUARANTINE', 'QUARANTINE_RELEASE', 'QUARANTINE_TO_DAMAGED']) action: string;
  @ApiProperty() @IsInt() @Min(1) quantity: number;
  @ApiProperty() @IsString() @Length(3, 300) reason: string;
  @ApiProperty() @IsString() @Length(8, 100) idempotencyKey: string;
}

export class CreateCountDto {
  @ApiProperty() @IsUUID() warehouseId: string;
  @ApiPropertyOptional({ type: [String], description: 'Restrict to these SKUs (cycle count). Omit for a full count.' })
  @IsOptional() @IsArray() @IsUUID('all', { each: true }) skuIds?: string[];
  @ApiPropertyOptional() @IsOptional() @IsBoolean() blind?: boolean;
}

export class CountLineDto {
  @ApiProperty() @IsUUID() itemId: string;
  @ApiProperty() @IsInt() @Min(0) countedQuantity: number;
}

export class SubmitCountDto {
  @ApiProperty({ type: [CountLineDto] }) @IsArray() @ValidateNested({ each: true }) @Type(() => CountLineDto)
  lines: CountLineDto[];
}

export class TransferItemDto {
  @ApiProperty() @IsUUID() skuId: string;
  @ApiProperty() @IsInt() @Min(1) quantity: number;
}

export class CreateTransferDto {
  @ApiProperty() @IsUUID() fromWarehouseId: string;
  @ApiProperty() @IsUUID() toWarehouseId: string;
  @ApiProperty({ type: [TransferItemDto] }) @IsArray() @ArrayMinSize(1) @ValidateNested({ each: true }) @Type(() => TransferItemDto)
  items: TransferItemDto[];
  @ApiPropertyOptional() @IsOptional() @IsString() reason?: string;
}

export class ReceiveTransferLineDto {
  @ApiProperty() @IsUUID() itemId: string;
  @ApiProperty() @IsInt() @Min(0) receivedQty: number;
}

export class ReceiveTransferDto {
  @ApiProperty({ type: [ReceiveTransferLineDto] }) @IsArray() @ValidateNested({ each: true }) @Type(() => ReceiveTransferLineDto)
  lines: ReceiveTransferLineDto[];
}
