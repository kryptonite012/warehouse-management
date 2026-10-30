import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  ArrayMinSize, IsArray, IsBoolean, IsEnum, IsInt, IsNumber, IsOptional, IsString, IsUUID, Length, Matches, Min, ValidateNested,
} from 'class-validator';
import { PageQuery } from '../../common/pagination';

const STATUS = ['DRAFT', 'ACTIVE', 'INACTIVE', 'DISCONTINUED'] as const;
const STORAGE = ['AMBIENT', 'CHILLED', 'FROZEN'] as const;
const UNITS = ['EACH', 'GRAM', 'KILOGRAM', 'MILLILITRE', 'LITRE', 'PACK'] as const;

export class SkuInputDto {
  @ApiProperty() @Matches(/^[A-Z0-9-]{3,40}$/) code: string;
  @ApiPropertyOptional() @IsOptional() @IsString() variantName?: string;
  @ApiPropertyOptional({ enum: UNITS }) @IsOptional() @IsEnum(UNITS) unit?: (typeof UNITS)[number];
  @ApiPropertyOptional() @IsOptional() @IsNumber() @Min(0) netQuantity?: number;
  @ApiPropertyOptional() @IsOptional() @IsInt() @Min(0) weightGrams?: number;
  @ApiPropertyOptional() @IsOptional() @IsInt() @Min(0) lengthMm?: number;
  @ApiPropertyOptional() @IsOptional() @IsInt() @Min(0) widthMm?: number;
  @ApiPropertyOptional() @IsOptional() @IsInt() @Min(0) heightMm?: number;
  @ApiProperty() @IsNumber({ maxDecimalPlaces: 2 }) @Min(0) mrp: number;
  @ApiProperty() @IsNumber({ maxDecimalPlaces: 2 }) @Min(0) sellingPrice: number;
  @ApiProperty() @IsNumber({ maxDecimalPlaces: 2 }) @Min(0) purchasePrice: number;
  @ApiPropertyOptional() @IsOptional() @IsInt() @Min(0) reorderPoint?: number;
  @ApiPropertyOptional() @IsOptional() @IsInt() @Min(1) reorderQty?: number;
  @ApiPropertyOptional({ type: [String] }) @IsOptional() @IsArray() @Matches(/^[0-9A-Za-z-]{6,32}$/, { each: true }) barcodes?: string[];
}

export class CreateProductDto {
  @ApiProperty() @IsString() @Length(2, 200) name: string;
  @ApiPropertyOptional() @IsOptional() @IsString() @Length(0, 4000) description?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() brand?: string;
  @ApiProperty() @IsUUID() categoryId: string;
  @ApiPropertyOptional() @IsOptional() @IsUUID() subcategoryId?: string;
  @ApiPropertyOptional() @IsOptional() @IsUUID() taxCategoryId?: string;
  @ApiPropertyOptional({ enum: STORAGE }) @IsOptional() @IsEnum(STORAGE) storageCondition?: (typeof STORAGE)[number];
  @ApiPropertyOptional() @IsOptional() @IsInt() @Min(1) shelfLifeDays?: number;
  @ApiPropertyOptional() @IsOptional() @IsBoolean() batchTracked?: boolean;
  @ApiPropertyOptional() @IsOptional() @IsBoolean() expiryTracked?: boolean;
  @ApiPropertyOptional({ enum: STATUS }) @IsOptional() @IsEnum(STATUS) status?: (typeof STATUS)[number];
  @ApiProperty({ type: [SkuInputDto] }) @IsArray() @ArrayMinSize(1) @ValidateNested({ each: true }) @Type(() => SkuInputDto)
  skus: SkuInputDto[];
}

export class UpdateProductDto {
  @ApiProperty() @IsInt() version: number;
  @ApiPropertyOptional() @IsOptional() @IsString() @Length(2, 200) name?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() description?: string;
  @ApiPropertyOptional() @IsOptional() @IsUUID() categoryId?: string;
  @ApiPropertyOptional() @IsOptional() @IsUUID() subcategoryId?: string;
  @ApiPropertyOptional() @IsOptional() @IsUUID() taxCategoryId?: string;
  @ApiPropertyOptional({ enum: STORAGE }) @IsOptional() @IsEnum(STORAGE) storageCondition?: (typeof STORAGE)[number];
  @ApiPropertyOptional() @IsOptional() @IsInt() @Min(1) shelfLifeDays?: number;
  @ApiPropertyOptional({ enum: STATUS }) @IsOptional() @IsEnum(STATUS) status?: (typeof STATUS)[number];
}

export class UpdateSkuPriceDto {
  @ApiProperty() @IsInt() version: number;
  @ApiPropertyOptional() @IsOptional() @IsNumber({ maxDecimalPlaces: 2 }) @Min(0) mrp?: number;
  @ApiPropertyOptional() @IsOptional() @IsNumber({ maxDecimalPlaces: 2 }) @Min(0) sellingPrice?: number;
  @ApiPropertyOptional() @IsOptional() @IsNumber({ maxDecimalPlaces: 2 }) @Min(0) purchasePrice?: number;
  @ApiPropertyOptional() @IsOptional() @IsInt() @Min(0) reorderPoint?: number;
  @ApiPropertyOptional() @IsOptional() @IsInt() @Min(1) reorderQty?: number;
}

export class ProductListQuery extends PageQuery {
  @IsOptional() @IsUUID() categoryId?: string;
  @IsOptional() @IsEnum(STATUS) status?: string;
  @IsOptional() @IsEnum(STORAGE) storageCondition?: string;
  @IsOptional() @IsString() barcode?: string;
}

export class CreateCategoryDto {
  @ApiProperty() @IsString() @Length(2, 80) name: string;
  @ApiPropertyOptional() @IsOptional() @IsUUID() parentId?: string;
  @ApiPropertyOptional() @IsOptional() @IsInt() sortOrder?: number;
}

export class AddBarcodeDto {
  @ApiProperty() @Matches(/^[0-9A-Za-z-]{6,32}$/) barcode: string;
  @ApiPropertyOptional() @IsOptional() @IsBoolean() isPrimary?: boolean;
}
