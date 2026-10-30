import { ApiProperty } from '@nestjs/swagger';
import { IsNotEmpty, IsString, Length, Matches, MinLength } from 'class-validator';

export const PASSWORD_RULE = /^(?=.*[a-z])(?=.*[A-Z])(?=.*\d).{10,128}$/;
export const PASSWORD_MESSAGE = 'Password must be 10-128 chars with upper, lower case letters and a digit';

export class LoginDto {
  @ApiProperty({ description: 'Email address or phone number' })
  @IsString() @IsNotEmpty() @Length(3, 254)
  identifier: string;

  @ApiProperty()
  @IsString() @IsNotEmpty() @Length(1, 128)
  password: string;
}

export class RefreshDto {
  @ApiProperty() @IsString() @IsNotEmpty()
  refreshToken: string;
}

export class ForgotPasswordDto {
  @ApiProperty() @IsString() @IsNotEmpty()
  identifier: string;
}

export class ResetPasswordDto {
  @ApiProperty() @IsString() @IsNotEmpty()
  token: string;

  @ApiProperty() @IsString() @MinLength(10) @Matches(PASSWORD_RULE, { message: PASSWORD_MESSAGE })
  newPassword: string;
}
