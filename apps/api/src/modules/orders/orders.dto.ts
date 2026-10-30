import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { ArrayMaxSize, IsArray, IsBoolean, IsEnum, IsInt, IsOptional, IsString, IsUUID, Length, Max, Min, ValidateNested } from 'class-validator';
import { PageQuery } from '../../common/pagination';

export class OrderLineDto {
  @ApiProperty() @IsUUID() skuId: string;
  @ApiProperty() @IsInt() @Min(1) @Max(50) quantity: number;
}

export class PlaceOrderDto {
  @ApiProperty() @IsUUID() addressId: string;
  @ApiPropertyOptional({ description: 'Use the open cart when items are omitted' }) @IsOptional() @IsBoolean() fromCart?: boolean;
  @ApiPropertyOptional({ type: [OrderLineDto] }) @IsOptional() @IsArray() @ArrayMaxSize(100) @ValidateNested({ each: true }) @Type(() => OrderLineDto)
  items?: OrderLineDto[];
  @ApiProperty({ enum: ['UPI', 'CARD', 'NET_BANKING', 'WALLET', 'COD'] }) @IsEnum(['UPI', 'CARD', 'NET_BANKING', 'WALLET', 'COD'])
  paymentMethod: 'UPI' | 'CARD' | 'NET_BANKING' | 'WALLET' | 'COD';
  @ApiPropertyOptional() @IsOptional() @IsString() @Length(2, 40) promotionCode?: string;
  @ApiProperty({ description: 'Client-generated key; retries with the same key return the same order' }) @IsString() @Length(8, 100)
  idempotencyKey: string;
}

export class CartItemDto {
  @ApiProperty() @IsUUID() skuId: string;
  @ApiProperty({ description: '0 removes the item' }) @IsInt() @Min(0) @Max(50) quantity: number;
}

export class CancelOrderDto {
  @ApiProperty() @IsString() @Length(3, 300) reason: string;
}

export class OrderListQuery extends PageQuery {
  @IsOptional() @IsString() status?: string;
  @IsOptional() @IsUUID() darkStoreId?: string;
  @IsOptional() @IsUUID() customerId?: string;
}

export class ReturnRequestDto {
  @ApiProperty() @IsString() @Length(3, 300) reason: string;
}

export class ReturnLineDto {
  @ApiProperty() @IsUUID() orderItemId: string;
  @ApiProperty() @IsInt() @Min(0) quantity: number;
  @ApiProperty({ enum: ['RESALABLE', 'DAMAGED'] }) @IsEnum(['RESALABLE', 'DAMAGED']) condition: 'RESALABLE' | 'DAMAGED';
}

export class ReceiveReturnDto {
  @ApiProperty({ type: [ReturnLineDto] }) @IsArray() @ValidateNested({ each: true }) @Type(() => ReturnLineDto)
  lines: ReturnLineDto[];
}
