import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  ArrayUnique, IsArray, IsBoolean, IsEmail, IsEnum, IsIn, IsInt, IsOptional, IsString, IsUUID, Length, Matches, ValidateNested,
} from 'class-validator';
import { PageQuery } from '../../common/pagination';
import { PASSWORD_MESSAGE, PASSWORD_RULE } from '../auth/auth.dto';

export class ScopeDto {
  @ApiProperty({ enum: ['ORGANIZATION', 'REGION', 'WAREHOUSE'] })
  @IsIn(['ORGANIZATION', 'REGION', 'WAREHOUSE'])
  scopeType: 'ORGANIZATION' | 'REGION' | 'WAREHOUSE';

  @ApiProperty() @IsUUID()
  scopeId: string;
}

export class CreateUserDto {
  @ApiProperty() @IsString() @Length(2, 120)
  fullName: string;

  @ApiPropertyOptional() @IsOptional() @IsEmail()
  email?: string;

  @ApiPropertyOptional() @IsOptional() @Matches(/^\+?[0-9]{10,15}$/)
  phone?: string;

  @ApiProperty() @Matches(PASSWORD_RULE, { message: PASSWORD_MESSAGE })
  password: string;

  @ApiProperty({ type: [String], description: 'Role codes, e.g. PICKER' })
  @IsArray() @ArrayUnique() @IsString({ each: true })
  roles: string[];

  @ApiPropertyOptional({ type: [ScopeDto] })
  @IsOptional() @IsArray() @ValidateNested({ each: true }) @Type(() => ScopeDto)
  scopes?: ScopeDto[];
}

export class UpdateUserDto {
  @ApiProperty({ description: 'Current version for optimistic concurrency' })
  @IsInt()
  version: number;

  @ApiPropertyOptional() @IsOptional() @IsString() @Length(2, 120)
  fullName?: string;

  @ApiPropertyOptional() @IsOptional() @Matches(/^\+?[0-9]{10,15}$/)
  phone?: string;

  @ApiPropertyOptional({ enum: ['ACTIVE', 'SUSPENDED', 'DISABLED'] })
  @IsOptional() @IsEnum(['ACTIVE', 'SUSPENDED', 'DISABLED'])
  status?: 'ACTIVE' | 'SUSPENDED' | 'DISABLED';

  @ApiPropertyOptional({ type: [String] })
  @IsOptional() @IsArray() @ArrayUnique() @IsString({ each: true })
  roles?: string[];

  @ApiPropertyOptional({ type: [ScopeDto] })
  @IsOptional() @IsArray() @ValidateNested({ each: true }) @Type(() => ScopeDto)
  scopes?: ScopeDto[];
}

export class UserListQuery extends PageQuery {
  @IsOptional() @IsString()
  role?: string;

  @IsOptional() @IsEnum(['ACTIVE', 'INVITED', 'SUSPENDED', 'DISABLED'])
  status?: string;

  @IsOptional() @IsUUID()
  warehouseId?: string;
}

export class UpsertRoleDto {
  @ApiProperty() @Matches(/^[A-Z][A-Z0-9_]{2,40}$/)
  code: string;

  @ApiProperty() @IsString() @Length(2, 80)
  name: string;

  @ApiPropertyOptional() @IsOptional() @IsString()
  description?: string;

  @ApiProperty({ type: [String] }) @IsArray() @ArrayUnique() @IsString({ each: true })
  permissions: string[];
}

export class SetSuperAdminDto {
  @IsBoolean() value: boolean;
}
