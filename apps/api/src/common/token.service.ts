import { Injectable } from '@nestjs/common';
import { createHash, randomBytes } from 'crypto';
import * as jwt from 'jsonwebtoken';
import { ActorKind } from './auth-context';

export interface AccessTokenClaims {
  sub: string;
  org: string;
  kind: ActorKind;
  sid?: string;
}

@Injectable()
export class TokenService {
  private readonly secret: string;
  readonly accessTtl: number;

  constructor() {
    const secret = process.env.JWT_ACCESS_SECRET;
    if (!secret || secret.length < 32) {
      throw new Error('JWT_ACCESS_SECRET must be set and at least 32 characters long');
    }
    this.secret = secret;
    this.accessTtl = Number(process.env.JWT_ACCESS_TTL_SECONDS ?? 900);
  }

  signAccess(claims: AccessTokenClaims): string {
    return jwt.sign(claims, this.secret, { expiresIn: this.accessTtl, algorithm: 'HS256', issuer: 'quickstore' });
  }

  verifyAccess(token: string): AccessTokenClaims {
    return jwt.verify(token, this.secret, { algorithms: ['HS256'], issuer: 'quickstore' }) as AccessTokenClaims;
  }

  /** Opaque high-entropy token; only its SHA-256 hash is stored. */
  newOpaqueToken(): { token: string; hash: string } {
    const token = randomBytes(48).toString('base64url');
    return { token, hash: TokenService.hash(token) };
  }

  static hash(value: string): string {
    return createHash('sha256').update(value).digest('hex');
  }
}
