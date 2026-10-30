import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  IsArray, IsBoolean, IsEnum, IsInt, IsLatitude, IsLongitude, IsNumber, IsObject, IsOptional, IsString, IsUUID, Length, Matches, Max, Min, ValidateNested,
} from 'class-validator';
import { PageQuery } from '../../common/pagination';

export const WAREHOUSE_TYPES = ['CENTRAL_WAREHOUSE', 'DISTRIBUTION_CENTER', 'DARK_STORE'] as const;
export const SITE_STATUSES = ['ACTIVE', 'INACTIVE', 'MAINTENANCE', 'CLOSED'] as const;
export const LEVELS = ['ZONE', 'AISLE', 'RACK', 'SHELF', 'BIN'] as const;

export class DarkStoreSettingsDto {
  @ApiPropertyOptional() @IsOptional() @IsUUID() supplyingWarehouseId?: string;
  @ApiPropertyOptional() @IsOptional() @IsNumber() @Min(0.5) @Max(30) serviceRadiusKm?: number;
  @ApiPropertyOptional({ type: [String] }) @IsOptional() @IsArray() @Matches(/^[0-9]{6}$/, { each: true }) servicePostalCodes?: string[];
  @ApiPropertyOptional() @IsOptional() @IsInt() @Min(1) maxOrdersPerHour?: number;
  @ApiPropertyOptional() @IsOptional() @IsInt() @Min(1) maxConcurrentOrders?: number;
  @ApiPropertyOptional() @IsOptional() @IsBoolean() acceptingOrders?: boolean;
}

export class CreateWarehouseDto {
  @ApiProperty() @Matches(/^[A-Z0-9-]{2,20}$/) code: string;
  @ApiProperty() @IsString() @Length(2, 120) name: string;
  @ApiProperty({ enum: WAREHOUSE_TYPES }) @IsEnum(WAREHOUSE_TYPES) type: (typeof WAREHOUSE_TYPES)[number];
  @ApiPropertyOptional() @IsOptional() @IsUUID() regionId?: string;
  @ApiProperty() @IsString() @Length(3, 200) addressLine1: string;
  @ApiPropertyOptional() @IsOptional() @IsString() addressLine2?: string;
  @ApiProperty() @IsString() city: string;
  @ApiProperty() @IsString() state: string;
  @ApiProperty() @Matches(/^[0-9]{6}$/) postalCode: string;
  @ApiPropertyOptional() @IsOptional() @IsLatitude() latitude?: number;
  @ApiPropertyOptional() @IsOptional() @IsLongitude() longitude?: number;
  @ApiPropertyOptional() @IsOptional() @IsInt() @Min(0) capacityUnits?: number;
  @ApiPropertyOptional() @IsOptional() @IsUUID() managerId?: string;
  @ApiPropertyOptional({ example: { mon: ['06:00', '23:59'] } }) @IsOptional() @IsObject() operatingHours?: Record<string, string[]>;
  @ApiPropertyOptional({ type: [String] }) @IsOptional() @IsArray() @IsEnum(['AMBIENT', 'CHILLED', 'FROZEN'], { each: true }) temperatureZones?: string[];
  @ApiPropertyOptional({ type: DarkStoreSettingsDto }) @IsOptional() @ValidateNested() @Type(() => DarkStoreSettingsDto)
  darkStore?: DarkStoreSettingsDto;
}

export class UpdateWarehouseDto {
  @ApiProperty() @IsInt() version: number;
  @ApiPropertyOptional() @IsOptional() @IsString() @Length(2, 120) name?: string;
  @ApiPropertyOptional({ enum: SITE_STATUSES }) @IsOptional() @IsEnum(SITE_STATUSES) status?: (typeof SITE_STATUSES)[number];
  @ApiPropertyOptional() @IsOptional() @IsUUID() regionId?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() addressLine1?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() city?: string;
  @ApiPropertyOptional() @IsOptional() @IsLatitude() latitude?: number;
  @ApiPropertyOptional() @IsOptional() @IsLongitude() longitude?: number;
  @ApiPropertyOptional() @IsOptional() @IsInt() @Min(0) capacityUnits?: number;
  @ApiPropertyOptional() @IsOptional() @IsUUID() managerId?: string;
  @ApiPropertyOptional() @IsOptional() @IsObject() operatingHours?: Record<string, string[]>;
  @ApiPropertyOptional() @IsOptional() @IsArray() temperatureZones?: string[];
  @ApiPropertyOptional({ type: DarkStoreSettingsDto }) @IsOptional() @ValidateNested() @Type(() => DarkStoreSettingsDto)
  darkStore?: DarkStoreSettingsDto;
}

export class WarehouseListQuery extends PageQuery {
  @IsOptional() @IsEnum(WAREHOUSE_TYPES) type?: string;
  @IsOptional() @IsEnum(SITE_STATUSES) status?: string;
  @IsOptional() @IsUUID() regionId?: string;
}

export class CreateLocationDto {
  @ApiPropertyOptional() @IsOptional() @IsUUID() parentId?: string;
  @ApiProperty({ enum: LEVELS }) @IsEnum(LEVELS) level: (typeof LEVELS)[number];
  @ApiProperty() @Matches(/^[A-Z0-9]{1,8}$/) code: string;
  @ApiPropertyOptional() @IsOptional() @IsEnum(['AMBIENT', 'CHILLED', 'FROZEN']) temperatureZone?: string;
  @ApiPropertyOptional() @IsOptional() @IsInt() @Min(0) capacityUnits?: number;
  @ApiPropertyOptional() @IsOptional() @IsInt() @Min(0) pickSequence?: number;
}

export class BulkLayoutDto {
  @ApiProperty({ example: 'A' }) @Matches(/^[A-Z0-9]{1,8}$/) zoneCode: string;
  @ApiPropertyOptional() @IsOptional() @IsEnum(['AMBIENT', 'CHILLED', 'FROZEN']) temperatureZone?: string;
  @ApiProperty() @IsInt() @Min(1) @Max(50) aisles: number;
  @ApiProperty() @IsInt() @Min(1) @Max(50) racksPerAisle: number;
  @ApiProperty() @IsInt() @Min(1) @Max(20) shelvesPerRack: number;
  @ApiProperty() @IsInt() @Min(1) @Max(20) binsPerShelf: number;
  @ApiPropertyOptional() @IsOptional() @IsInt() @Min(1) binCapacityUnits?: number;
}

export class UpdateLocationDto {
  @ApiPropertyOptional({ enum: ['AVAILABLE', 'RESERVED', 'RESTRICTED', 'BLOCKED'] })
  @IsOptional() @IsEnum(['AVAILABLE', 'RESERVED', 'RESTRICTED', 'BLOCKED']) state?: 'AVAILABLE' | 'RESERVED' | 'RESTRICTED' | 'BLOCKED';
  @ApiPropertyOptional() @IsOptional() @IsInt() @Min(0) capacityUnits?: number;
  @ApiPropertyOptional() @IsOptional() @IsInt() @Min(0) pickSequence?: number;
}

export class AssignSkuLocationDto {
  @ApiProperty() @IsUUID() skuId: string;
  @ApiProperty() @IsUUID() locationId: string;
  @ApiPropertyOptional() @IsOptional() @IsBoolean() isPrimary?: boolean;
}
