import { z } from 'zod';

// These schemas are the transport boundary for both the API and CLI. Keep this
// module free of Express, oRPC server code, repositories, and provider gateways.
// Stateful rules belong in the spend-controls domain service.
const spendScopeSchema = z.enum(['account', 'agent-session']);
const budgetPeriodSchema = z.enum(['day', 'week', 'month']);
const positiveWholeUsdSchema = z.number().int().positive();

const throttleEntrySchema = z
  .object({
    scope: spendScopeSchema,
    capUsd: positiveWholeUsdSchema,
    createdAt: z.number().int().nonnegative(),
    updatedAt: z.number().int().nonnegative(),
  })
  .strict();

const sessionBurnSchema = z
  .object({
    session: z.string().min(1),
    agent: z.string().nullable(),
    sessionLabel: z.string().nullable(),
    user: z.string().nullable(),
    rateUsd: z.number().nonnegative(),
  })
  .strict();

export const listThrottlesResponseSchema = z
  .object({
    entries: z.array(throttleEntrySchema),
    burnRate: z
      .object({
        account: z.object({ currentUsd: z.number().nonnegative() }).strict(),
        sessions: z.array(sessionBurnSchema).optional(),
      })
      .strict(),
  })
  .strict();

const budgetEntrySchema = z
  .object({
    period: budgetPeriodSchema,
    scope: spendScopeSchema,
    capUsd: positiveWholeUsdSchema,
    createdAt: z.number().int().nonnegative(),
    updatedAt: z.number().int().nonnegative(),
  })
  .strict();

const sessionSpendSchema = z
  .object({
    session: z.string().min(1),
    agent: z.string().nullable(),
    sessionLabel: z.string().nullable(),
    user: z.string().nullable(),
    actualUsd: z.number().nonnegative(),
    estimatedUsd: z.number().nonnegative(),
    totalUsd: z.number().nonnegative(),
  })
  .strict();

const spendWindowSchema = z
  .object({
    period: budgetPeriodSchema,
    scope: spendScopeSchema,
    startMs: z.number().int().nonnegative(),
    endMs: z.number().int().positive(),
    actualUsd: z.number().nonnegative(),
    estimatedUsd: z.number().nonnegative(),
    totalUsd: z.number().nonnegative(),
    agentSessionCount: z.number().int().nonnegative().optional(),
    sessions: z.array(sessionSpendSchema).optional(),
  })
  .strict()
  .check((context) => {
    if (context.value.endMs <= context.value.startMs) {
      context.issues.push({
        code: 'custom',
        input: context.value,
        path: ['endMs'],
        message: 'endMs must be after startMs',
      });
    }
  });

export const listBudgetsResponseSchema = z
  .object({
    entries: z.array(budgetEntrySchema),
    spend: z.array(spendWindowSchema),
  })
  .strict();

export const spendCapInputSchema = z
  .object({ capUsd: positiveWholeUsdSchema })
  .strict();

export const setThrottleRequestSchema = z
  .object({
    params: z.object({ scope: spendScopeSchema }).strict(),
    body: spendCapInputSchema,
  })
  .transform(({ params, body }) => ({ ...params, ...body }));

export const unsetThrottleRequestSchema = z.object({
  params: z.object({ scope: spendScopeSchema }).strict(),
});

export const setBudgetRequestSchema = z
  .object({
    params: z
      .object({ period: budgetPeriodSchema, scope: spendScopeSchema })
      .strict(),
    body: spendCapInputSchema,
  })
  .transform(({ params, body }) => ({ ...params, ...body }));

export const unsetBudgetRequestSchema = z.object({
  params: z
    .object({ period: budgetPeriodSchema, scope: spendScopeSchema })
    .strict(),
});

export type SpendScope = z.output<typeof spendScopeSchema>;
export type BudgetPeriod = z.output<typeof budgetPeriodSchema>;
export type SessionBurn = z.output<typeof sessionBurnSchema>;
export type SessionSpend = z.output<typeof sessionSpendSchema>;
export type ListThrottlesResponse = z.output<
  typeof listThrottlesResponseSchema
>;
export type ListBudgetsResponse = z.output<typeof listBudgetsResponseSchema>;
export type SetThrottleInput = z.output<typeof setThrottleRequestSchema>;
export type UnsetThrottleInput = z.output<
  typeof unsetThrottleRequestSchema
>['params'];
export type SetBudgetInput = z.output<typeof setBudgetRequestSchema>;
export type UnsetBudgetInput = z.output<
  typeof unsetBudgetRequestSchema
>['params'];
