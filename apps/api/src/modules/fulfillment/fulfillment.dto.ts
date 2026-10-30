import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { ArrayMaxSize, ArrayMinSize, IsArray, IsEnum, IsInt, IsOptional, IsString, IsUUID, Length, Min, ValidateNested } from 'class-validator';

export class CreatePickingTaskDto {
  @ApiProperty() @IsUUID() orderId: string;
}

export class CreateWaveDto {
  @ApiProperty({ type: [String] }) @IsArray() @ArrayMinSize(1) @ArrayMaxSize(20) @IsUUID('all', { each: true }) orderIds: string[];
  @ApiPropertyOptional({ enum: ['BATCH', 'WAVE', 'ZONE'] }) @IsOptional() @IsEnum(['BATCH', 'WAVE', 'ZONE']) mode?: 'BATCH' | 'WAVE' | 'ZONE';
  @ApiPropertyOptional() @IsOptional() @IsUUID() assignToId?: string;
}

export class ScanDto {
  @ApiProperty() @IsUUID() itemId: string;
  @ApiProperty() @IsString() @Length(4, 64) barcode: string;
  @ApiProperty() @IsInt() @Min(1) quantity: number;
}

export class ShortPickDto {
  @ApiProperty() @IsUUID() itemId: string;
  @ApiProperty() @IsInt() @Min(0) pickedQty: number;
}

export class CompletePickDto {
  @ApiPropertyOptional({ type: [ShortPickDto], description: 'Lines picked short; other lines use their scanned quantity' })
  @IsOptional() @IsArray() @ValidateNested({ each: true }) @Type(() => ShortPickDto)
  shortPicks?: ShortPickDto[];
}

export class PackLineDto {
  @ApiProperty() @IsUUID() orderItemId: string;
  @ApiProperty() @IsInt() @Min(0) quantity: number;
}

export class CompletePackDto {
  @ApiProperty({ enum: ['BAG_SMALL', 'BAG_LARGE', 'BOX', 'COLD_BAG'] }) @IsEnum(['BAG_SMALL', 'BAG_LARGE', 'BOX', 'COLD_BAG']) packagingType: string;
  @ApiProperty({ type: [PackLineDto] }) @IsArray() @ValidateNested({ each: true }) @Type(() => PackLineDto)
  lines: PackLineDto[];
}

export class TaskQuery {
  @IsOptional() @IsUUID() warehouseId?: string;
  @IsOptional() @IsEnum(['PENDING', 'ASSIGNED', 'IN_PROGRESS', 'COMPLETED', 'CANCELLED']) status?: string;
  @IsOptional() @IsEnum(['me']) assigned?: 'me';
}
