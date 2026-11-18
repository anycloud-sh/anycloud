import type { Response } from 'express';
import type { z } from 'zod';

interface NativeApiError {
  defined: true;
  code: string;
  status: number;
  message: string;
}

export function sendNativeApiError(
  res: Response,
  status: number,
  code: string,
  message: string,
): void {
  res.status(status).json({
    defined: true,
    code,
    status,
    message,
  } satisfies NativeApiError);
}

export function parseNativeRequest<TSchema extends z.ZodType>(
  schema: TSchema,
  input: unknown,
  res: Response,
  code: string,
): z.output<TSchema> | undefined {
  const parsed = schema.safeParse(input);
  if (parsed.success) return parsed.data;

  const detail = parsed.error.issues
    .map((issue) => {
      const path = issue.path.join('.');
      return path ? `${path}: ${issue.message}` : issue.message;
    })
    .join('; ');
  sendNativeApiError(res, 400, code, detail || 'Invalid request');
  return undefined;
}
