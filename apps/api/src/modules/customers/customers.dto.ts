import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsBoolean, IsEmail, IsLatitude, IsLongitude, IsOptional, IsString, Length, Matches } from 'class-validator';
import { PASSWORD_MESSAGE, PASSWORD_RULE } from '../auth/auth.dto';

export class RegisterCustomerDto {
  @ApiPropertyOptional({ description: 'Organization (brand) code; defaults to STOREFRONT_ORG_CODE' }) @IsOptional() @IsString() organizationCode?: string;
  @ApiProperty() @IsString() @Length(2, 120) fullName: string;
  @ApiProperty() @Matches(/^\+?[0-9]{10,15}$/) phone: string;
  @ApiPropertyOptional() @IsOptional() @IsEmail() email?: string;
  @ApiProperty() @Matches(PASSWORD_RULE, { message: PASSWORD_MESSAGE }) password: string;
}

export class CustomerLoginDto {
  @ApiPropertyOptional() @IsOptional() @IsString() organizationCode?: string;
  @ApiProperty({ description: 'Phone or email' }) @IsString() @Length(3, 254) identifier: string;
  @ApiProperty() @IsString() @Length(1, 128) password: string;
}

export class UpdateProfileDto {
  @ApiPropertyOptional() @IsOptional() @IsString() @Length(2, 120) fullName?: string;
  @ApiPropertyOptional() @IsOptional() @IsEmail() email?: string;
}

export class AddressDto {
  @ApiPropertyOptional() @IsOptional() @IsString() @Length(1, 30) label?: string;
  @ApiProperty() @IsString() @Length(3, 200) line1: string;
  @ApiPropertyOptional() @IsOptional() @IsString() line2?: string;
  @ApiProperty() @IsString() city: string;
  @ApiProperty() @IsString() state: string;
  @ApiProperty() @Matches(/^[0-9]{6}$/) postalCode: string;
  @ApiPropertyOptional() @IsOptional() @IsLatitude() latitude?: number;
  @ApiPropertyOptional() @IsOptional() @IsLongitude() longitude?: number;
  @ApiPropertyOptional() @IsOptional() @IsBoolean() isDefault?: boolean;
}
