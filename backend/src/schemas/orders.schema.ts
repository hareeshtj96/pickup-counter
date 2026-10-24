import { z } from 'zod';
import { MAX_LINE_ITEMS, MAX_QUANTITY_PER_ITEM } from '../services/orders.service.js';

const orderItemSchema = z
  .object({
    productId: z.string().uuid('productId must be a valid UUID'),
    quantity: z
      .number({ invalid_type_error: 'quantity must be a number' })
      .int('quantity must be a whole number')
      .min(1, 'quantity must be at least 1')
      .max(MAX_QUANTITY_PER_ITEM, `quantity must be at most ${MAX_QUANTITY_PER_ITEM}`),
  })
  // Unknown fields (e.g. a client-supplied price or stock) are rejected.
  .strict();

export const createOrderBodySchema = z
  .object({
    items: z
      .array(orderItemSchema)
      .min(1, 'items must contain at least one item')
      .max(MAX_LINE_ITEMS, `items must contain at most ${MAX_LINE_ITEMS} entries`)
      .superRefine((items, ctx) => {
        // Duplicate products are rejected rather than merged, so the client
        // always sees exactly what was ordered.
        const seen = new Set<string>();
        items.forEach((item, index) => {
          const key = item.productId.toLowerCase();
          if (seen.has(key)) {
            ctx.addIssue({
              code: z.ZodIssueCode.custom,
              path: [index, 'productId'],
              message: 'Each product may appear only once; combine the quantities instead',
            });
          }
          seen.add(key);
        });
      }),
  })
  .strict();

export type CreateOrderBody = z.infer<typeof createOrderBodySchema>;

export const orderIdParamsSchema = z.object({
  id: z.string().uuid('id must be a valid UUID'),
});

export type OrderIdParams = z.infer<typeof orderIdParamsSchema>;

// Collection needs no input beyond the order id; any body fields are rejected.
export const collectOrderBodySchema = z.object({}).strict().optional();
