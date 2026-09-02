import { z } from 'zod';

export const analyzeRequestSchema = z.object({
  language: z.string().min(1, 'language is required'),
  code: z.string().min(1, 'code is required')
});

export type AnalyzeRequest = z.infer<typeof analyzeRequestSchema>;

export const analyzeUploadQuerySchema = z.object({
  language: z.string().optional()
});

export type AnalyzeUploadQuery = z.infer<typeof analyzeUploadQuerySchema>;
