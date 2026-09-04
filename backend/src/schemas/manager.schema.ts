import { z } from 'zod';
import { AGENT_ACTIONS } from '../types/agent-state';

export const managerDecisionSchema = z.object({
  action: z.enum(AGENT_ACTIONS as unknown as [string, ...string[]]),
  arguments: z.record(z.any()).optional().default({}),
  reason: z.string().min(1).max(300)
});

export type ManagerDecisionOutput = z.infer<typeof managerDecisionSchema>;
