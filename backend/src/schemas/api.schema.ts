import { z } from 'zod';

export const analyzeRequestSchema = z.object({
  language: z.string().min(1, 'language is required'),
  code: z.string().min(1, 'code is required'),
  async: z.boolean().optional().default(false)
});

export type AnalyzeRequest = z.infer<typeof analyzeRequestSchema>;

export const analyzeUploadQuerySchema = z.object({
  language: z.string().optional(),
  async: z
    .string()
    .optional()
    .transform((val) => val === 'true')
});

export type AnalyzeUploadQuery = z.infer<typeof analyzeUploadQuerySchema>;

