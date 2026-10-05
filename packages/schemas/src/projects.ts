import { z } from 'zod';
export const NewProjectSchema = z.object({
  id: z.string().uuid(), name: z.string().trim().min(1).max(120),
  description: z.string().trim().max(4000).default(''), channelId: z.string().min(1).max(200),
}).strict();
export const NewTaskSchema = z.object({
  id: z.string().uuid(), title: z.string().trim().min(1).max(200),
  instructions: z.string().trim().min(1).max(12000), acceptanceCriteria: z.string().trim().min(1).max(8000),
  agentName: z.string().trim().min(1).max(200),
}).strict();
export const TaskActionSchema = z.object({version: z.number().int().nonnegative()}).strict();
export const SubmitDeliverableSchema = TaskActionSchema.extend({eventId: z.string().min(1).max(200)});
export const ReviewSchema = TaskActionSchema.extend({decision: z.enum(['approve', 'request_changes']), feedback: z.string().trim().max(8000).default('')})
  .refine(value => value.decision !== 'request_changes' || value.feedback.length > 0, 'Feedback is required when requesting changes');
export type Project = {id: string; ownerId: string; channelId: string; name: string; description: string; createdAt: number};
export type Task = z.infer<typeof NewTaskSchema> & {
  projectId: string; version: number; status: 'queued' | 'working' | 'needs_review' | 'changes_requested' | 'done';
  attempt: number; dispatchEventId: string | null; dispatchedAt: number | null;
  feedback: string; deliverableId: string | null; createdAt: number; updatedAt: number;
};
export type Deliverable = {id: string; taskId: string; attempt: number; eventId: string; text: string; submittedBy: string; createdAt: number};
export type Review = {id: string; taskId: string; deliverableId: string; decision: 'approve' | 'request_changes'; feedback: string; reviewerId: string; createdAt: number};
export type ProjectDetail = Project & {tasks: Task[]; deliverables: Deliverable[]; reviews: Review[]};
