import { ApiProperty } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { ArrayMaxSize, IsArray, IsDateString, IsEnum, IsInt, IsObject, IsString, IsUUID, Length, Min, ValidateNested } from 'class-validator';

/** Operations a dark store may perform while disconnected (explicit allow-list). */
export const OFFLINE_OPS = ['PICK_SCAN', 'DAMAGE_REPORT', 'COUNT_SUBMIT', 'TRANSFER_RECEIVE'] as const;
export type OfflineOp = (typeof OFFLINE_OPS)[number];

export class RegisterDeviceDto {
  @ApiProperty() @IsUUID() warehouseId: string;
  @ApiProperty() @IsString() @Length(2, 80) name: string;
  @ApiProperty({ enum: OFFLINE_OPS, isArray: true }) @IsArray() @IsEnum(OFFLINE_OPS, { each: true }) allowedOps: OfflineOp[];
}

export class SyncOperationDto {
  @ApiProperty({ description: 'Globally unique id generated on the device (UUID)' }) @IsUUID() clientOpId: string;
  @ApiProperty({ description: 'Monotonic per-device sequence' }) @IsInt() @Min(1) sequence: number;
  @ApiProperty({ enum: OFFLINE_OPS }) @IsEnum(OFFLINE_OPS) opType: OfflineOp;
  @ApiProperty() @IsDateString() occurredAt: string;
  @ApiProperty({ description: 'Employee who performed the action on the device' }) @IsUUID() performedBy: string;
  @ApiProperty() @IsObject() payload: Record<string, any>;
}

export class PushDto {
  @ApiProperty({ type: [SyncOperationDto] }) @IsArray() @ArrayMaxSize(500) @ValidateNested({ each: true }) @Type(() => SyncOperationDto)
  operations: SyncOperationDto[];
}

export class ResolveConflictDto {
  @ApiProperty({ enum: ['DISMISS', 'RETRY'] }) @IsEnum(['DISMISS', 'RETRY']) action: 'DISMISS' | 'RETRY';
  @ApiProperty() @IsString() @Length(3, 300) note: string;
}
