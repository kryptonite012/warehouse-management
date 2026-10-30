import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsDateString, IsEnum, IsLatitude, IsLongitude, IsOptional, IsString, IsUUID, Length, Matches } from 'class-validator';

export class CreateRiderDto {
  @ApiProperty() @IsUUID() homeStoreId: string;
  @ApiProperty() @IsString() @Length(2, 120) fullName: string;
  @ApiProperty() @Matches(/^\+?[0-9]{10,15}$/) phone: string;
  @ApiProperty({ enum: ['BICYCLE', 'EV_SCOOTER', 'MOTORCYCLE'] }) @IsEnum(['BICYCLE', 'EV_SCOOTER', 'MOTORCYCLE']) vehicleType: string;
  @ApiPropertyOptional() @IsOptional() @IsString() vehicleNumber?: string;
  @ApiPropertyOptional({ description: 'Link to an employee login with the DELIVERY_PARTNER role' }) @IsOptional() @IsUUID() userId?: string;
}

export class RiderAvailabilityDto {
  @ApiProperty({ enum: ['OFFLINE', 'AVAILABLE', 'SUSPENDED'] }) @IsEnum(['OFFLINE', 'AVAILABLE', 'SUSPENDED']) status: 'OFFLINE' | 'AVAILABLE' | 'SUSPENDED';
}

export class ShiftDto {
  @ApiProperty() @IsDateString() startsAt: string;
  @ApiProperty() @IsDateString() endsAt: string;
}

export class AssignDto {
  @ApiProperty() @IsUUID() orderId: string;
  @ApiPropertyOptional({ description: 'Omit to auto-select the least-loaded available rider of the store' }) @IsOptional() @IsUUID() riderId?: string;
}

export class DeliveryStatusDto {
  @ApiProperty({ enum: ['ACCEPTED', 'PICKED_UP', 'OUT_FOR_DELIVERY', 'FAILED'] }) @IsEnum(['ACCEPTED', 'PICKED_UP', 'OUT_FOR_DELIVERY', 'FAILED'])
  status: 'ACCEPTED' | 'PICKED_UP' | 'OUT_FOR_DELIVERY' | 'FAILED';
  @ApiPropertyOptional({ description: 'Only send a real device GPS fix' }) @IsOptional() @IsLatitude() latitude?: number;
  @ApiPropertyOptional() @IsOptional() @IsLongitude() longitude?: number;
  @ApiPropertyOptional() @IsOptional() @IsString() @Length(0, 300) note?: string;
}

export class ProofDto {
  @ApiProperty({ enum: ['OTP', 'PHOTO', 'SIGNATURE'] }) @IsEnum(['OTP', 'PHOTO', 'SIGNATURE']) method: 'OTP' | 'PHOTO' | 'SIGNATURE';
  @ApiPropertyOptional() @IsOptional() @Matches(/^\d{4}$/) otp?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() photoKey?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() @Length(1, 120) receiverName?: string;
  @ApiPropertyOptional() @IsOptional() @IsLatitude() latitude?: number;
  @ApiPropertyOptional() @IsOptional() @IsLongitude() longitude?: number;
}
