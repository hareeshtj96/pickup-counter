import { z } from 'zod';

export const PAYMENT_EVENT_STATUSES = ['captured', 'failed'] as const;

export const paymentWebhookSchema = z
  .object({
    eventId: z
      .string()
      .min(1, 'eventId is required')
      .max(200, 'eventId must be at most 200 characters')
      .regex(/^[A-Za-z0-9_.:-]+$/, 'eventId may contain only letters, digits and _ . : -'),
    orderId: z.string().uuid('orderId must be a valid UUID'),
    amountPaise: z
      .number({ invalid_type_error: 'amountPaise must be a number' })
      .int('amountPaise must be a whole number of paise')
      .positive('amountPaise must be positive')
      .max(2_147_483_647, 'amountPaise is too large'),
    status: z.enum(PAYMENT_EVENT_STATUSES, {
      errorMap: () => ({ message: `status must be one of: ${PAYMENT_EVENT_STATUSES.join(', ')}` }),
    }),
  })
  .strict();

export type PaymentWebhookPayload = z.infer<typeof paymentWebhookSchema>;
