import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  ArrayMinSize, IsArray, IsDateString, IsEmail, IsInt, IsNumber, IsOptional, IsString, IsUUID, Length, Matches, Min, ValidateNested,
} from 'class-validator';
import { PageQuery } from '../../common/pagination';

export const GSTIN = /^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z][1-9A-Z]Z[0-9A-Z]$/;

export class CreateSupplierDto {
  @ApiProperty() @Matches(/^[A-Z0-9-]{2,20}$/) code: string;
  @ApiProperty() @IsString() @Length(2, 160) name: string;
  @ApiPropertyOptional() @IsOptional() @Matches(GSTIN, { message: 'Invalid GSTIN format' }) gstin?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() contactName?: string;
  @ApiPropertyOptional() @IsOptional() @IsEmail() email?: string;
  @ApiPropertyOptional() @IsOptional() @Matches(/^\+?[0-9]{10,15}$/) phone?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() address?: string;
  @ApiPropertyOptional() @IsOptional() @IsInt() @Min(0) paymentTermsDays?: number;
  @ApiPropertyOptional() @IsOptional() @IsInt() @Min(0) leadTimeDays?: number;
}

export class UpdateSupplierDto {
  @ApiPropertyOptional() @IsOptional() @IsString() @Length(2, 160) name?: string;
  @ApiPropertyOptional() @IsOptional() @Matches(GSTIN) gstin?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() contactName?: string;
  @ApiPropertyOptional() @IsOptional() @IsEmail() email?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() phone?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() address?: string;
  @ApiPropertyOptional() @IsOptional() @IsInt() @Min(0) paymentTermsDays?: number;
  @ApiPropertyOptional() @IsOptional() @IsInt() @Min(0) leadTimeDays?: number;
  @ApiPropertyOptional() @IsOptional() @IsString() status?: string;
}

export class SupplierPriceDto {
  @ApiProperty() @IsUUID() skuId: string;
  @ApiProperty() @IsNumber({ maxDecimalPlaces: 2 }) @Min(0) unitCost: number;
  @ApiPropertyOptional() @IsOptional() @IsString() supplierSku?: string;
  @ApiPropertyOptional() @IsOptional() @IsInt() @Min(1) minOrderQty?: number;
}

export class PoItemDto {
  @ApiProperty() @IsUUID() skuId: string;
  @ApiProperty() @IsInt() @Min(1) orderedQty: number;
  @ApiPropertyOptional({ description: 'Defaults to the latest supplier price' }) @IsOptional() @IsNumber({ maxDecimalPlaces: 2 }) @Min(0) unitCost?: number;
}

export class CreatePurchaseOrderDto {
  @ApiProperty() @IsUUID() supplierId: string;
  @ApiProperty() @IsUUID() warehouseId: string;
  @ApiPropertyOptional() @IsOptional() @IsDateString() expectedAt?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() notes?: string;
  @ApiProperty({ type: [PoItemDto] }) @IsArray() @ArrayMinSize(1) @ValidateNested({ each: true }) @Type(() => PoItemDto)
  items: PoItemDto[];
}

export class PoListQuery extends PageQuery {
  @IsOptional() @IsString() status?: string;
  @IsOptional() @IsUUID() supplierId?: string;
  @IsOptional() @IsUUID() warehouseId?: string;
}

export class GrnItemDto {
  @ApiProperty() @IsUUID() skuId: string;
  @ApiProperty() @IsString() @Length(1, 60) batchNumber: string;
  @ApiPropertyOptional() @IsOptional() @IsDateString() manufacturedAt?: string;
  @ApiPropertyOptional() @IsOptional() @IsDateString() expiresAt?: string;
  @ApiProperty() @IsInt() @Min(1) receivedQty: number;
  @ApiPropertyOptional({ description: 'Invoiced unit cost; differences from the PO are flagged' }) @IsOptional() @IsNumber({ maxDecimalPlaces: 2 }) unitCost?: number;
}

export class CreateGoodsReceiptDto {
  @ApiProperty() @IsUUID() purchaseOrderId: string;
  @ApiPropertyOptional() @IsOptional() @IsString() supplierInvoiceNo?: string;
  @ApiProperty() @IsString() @Length(8, 100) idempotencyKey: string;
  @ApiProperty({ type: [GrnItemDto] }) @IsArray() @ArrayMinSize(1) @ValidateNested({ each: true }) @Type(() => GrnItemDto)
  items: GrnItemDto[];
}

export class InspectionLineDto {
  @ApiProperty() @IsUUID() itemId: string;
  @ApiProperty() @IsInt() @Min(0) acceptedQty: number;
  @ApiProperty() @IsInt() @Min(0) rejectedQty: number;
  @ApiProperty() @IsInt() @Min(0) damagedQty: number;
  @ApiPropertyOptional() @IsOptional() @IsString() rejectionReason?: string;
}

export class InspectDto {
  @ApiProperty({ type: [InspectionLineDto] }) @IsArray() @ArrayMinSize(1) @ValidateNested({ each: true }) @Type(() => InspectionLineDto)
  lines: InspectionLineDto[];
}
