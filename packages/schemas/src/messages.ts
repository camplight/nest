import { z } from "zod";
export const MAX_MESSAGE_ATTACHMENTS = 20;
export const SelectedMentionSchema = z
  .object({
    kind: z.enum(["AGENT", "HUMAN"]),
    name: z.string().min(1).max(200),
    start: z.number().int().nonnegative(),
    end: z.number().int().positive(),
  })
  .strict();
export type SelectedMention = z.infer<typeof SelectedMentionSchema>;
export const MessageAttachmentSchema = z
  .object({
    fileId: z.string().min(1).max(200),
    name: z.string().min(1).max(1000),
    mime: z.string().max(200).optional(),
    size: z.number().nonnegative().optional(),
  })
  .strict();
export const SendMessageSchema = z
  .object({
    id: z.string().uuid(),
    channelId: z.string().min(1).max(200),
    text: z.string().min(1).max(32000),
    targetAgentName: z.string().min(1).max(200).optional(),
    replyTo: z.string().min(1).max(200).optional(),
    mentions: z.array(SelectedMentionSchema).max(30).default([]),
    attachments: z.array(MessageAttachmentSchema).max(MAX_MESSAGE_ATTACHMENTS).default([]),
  })
  .strict();
export type SendMessage = z.infer<typeof SendMessageSchema>;
export type MentionNotification = {
  id: string;
  channelId: string;
  channelName: string;
  sender: string;
  text: string;
  createdAt: number;
  readAt: number | null;
};
