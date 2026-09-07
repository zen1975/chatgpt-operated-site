import { z } from 'zod';

export const ContentBlock = z.discriminatedUnion('type', [
  z.object({type:z.literal('paragraph'), content:z.string().min(1)}).strict(),
  z.object({type:z.literal('heading'), level:z.union([z.literal(2),z.literal(3),z.literal(4)]), content:z.string().min(1)}).strict(),
  z.object({type:z.literal('unordered_list'), items:z.array(z.string().min(1)).min(1)}).strict(),
  z.object({type:z.literal('ordered_list'), items:z.array(z.string().min(1)).min(1)}).strict(),
  z.object({type:z.literal('quote'), content:z.string().min(1)}).strict(),
  z.object({type:z.literal('image'), assetId:z.string().min(1), alt:z.string().default('')}).strict(),
  z.object({type:z.literal('table'), headers:z.array(z.string()), rows:z.array(z.array(z.string()))}).strict(),
  z.object({type:z.literal('reusable'), ref:z.string().min(1)}).strict(),
  z.object({type:z.literal('separator')}).strict()
]);

export const ContentAST = z.array(ContentBlock).min(1);
export type ContentBlockType = z.infer<typeof ContentBlock>;
export type ContentASTType = z.infer<typeof ContentAST>;
