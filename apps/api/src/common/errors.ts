import {
  ArgumentsHost,
  Catch,
  ExceptionFilter,
  HttpException,
  HttpStatus,
  Logger,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { Request, Response } from 'express';

/** Business-rule violation with a stable machine-readable code. */
export class DomainError extends HttpException {
  constructor(
    public readonly code: string,
    message: string,
    status: number = HttpStatus.UNPROCESSABLE_ENTITY,
    public readonly details?: unknown,
  ) {
    super({ code, message, details }, status);
  }
}

export const NotFound = (resource: string, id?: string) =>
  new DomainError('NOT_FOUND', `${resource}${id ? ` ${id}` : ''} not found`, HttpStatus.NOT_FOUND);

export const Conflict = (code: string, message: string, details?: unknown) =>
  new DomainError(code, message, HttpStatus.CONFLICT, details);

export const Forbidden = (message = 'You do not have permission to perform this action') =>
  new DomainError('FORBIDDEN', message, HttpStatus.FORBIDDEN);

/**
 * Standard error envelope:
 * { error: { code, message, details?, requestId }, statusCode }
 */
@Catch()
export class GlobalExceptionFilter implements ExceptionFilter {
  private readonly logger = new Logger('Exceptions');

  catch(exception: unknown, host: ArgumentsHost) {
    const ctx = host.switchToHttp();
    const res = ctx.getResponse<Response>();
    const req = ctx.getRequest<Request & { requestId?: string }>();
    let status = HttpStatus.INTERNAL_SERVER_ERROR;
    let code = 'INTERNAL_ERROR';
    let message = 'An unexpected error occurred';
    let details: unknown;

    if (exception instanceof DomainError) {
      status = exception.getStatus();
      code = exception.code;
      message = exception.message;
      details = exception.details;
    } else if (exception instanceof HttpException) {
      status = exception.getStatus();
      const body: any = exception.getResponse();
      code = body?.code ?? HttpStatus[status] ?? 'HTTP_ERROR';
      if (status === 400) code = 'VALIDATION_FAILED';
      if (status === 429) code = 'RATE_LIMITED';
      message = Array.isArray(body?.message) ? 'Validation failed' : body?.message ?? exception.message;
      details = Array.isArray(body?.message) ? body.message : body?.details;
    } else if (exception instanceof Prisma.PrismaClientKnownRequestError) {
      if (exception.code === 'P2002') {
        status = HttpStatus.CONFLICT;
        code = 'DUPLICATE';
        message = `A record with the same ${(exception.meta?.target as string[] | undefined)?.join(', ') ?? 'key'} already exists`;
      } else if (exception.code === 'P2025') {
        status = HttpStatus.NOT_FOUND;
        code = 'NOT_FOUND';
        message = 'Record not found';
      } else if (exception.code === 'P2003') {
        status = HttpStatus.UNPROCESSABLE_ENTITY;
        code = 'INVALID_REFERENCE';
        message = 'Referenced record does not exist';
      }
    } else if (
      exception instanceof Prisma.PrismaClientUnknownRequestError &&
      /check constraint/i.test(exception.message)
    ) {
      status = HttpStatus.CONFLICT;
      code = 'INVARIANT_VIOLATION';
      message = 'Operation would violate an inventory or data invariant';
    }

    if (status >= 500) {
      this.logger.error(`${req.method} ${req.url} -> ${(exception as Error)?.stack ?? exception}`);
    }

    res.status(status).json({
      statusCode: status,
      error: { code, message, details, requestId: req.requestId },
    });
  }
}
