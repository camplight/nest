import {z} from 'zod';

export const SpeechSettingsSchema = z.object({
  enabled: z.boolean(),
  voiceId: z.string().trim().max(128).regex(/^[a-zA-Z0-9_-]*$/),
  style: z.enum(['neutral', 'friendly', 'calm', 'excited', 'confident', 'empathetic']),
  speed: z.number().min(0.5).max(2),
}).strict().refine(value => !value.enabled || value.voiceId.length > 0, {message: 'Choose a Fish Audio voice before enabling speech'});
export type SpeechSettings = z.infer<typeof SpeechSettingsSchema>;
export const DEFAULT_SPEECH_SETTINGS: SpeechSettings = {enabled:false, voiceId:'', style:'neutral', speed:1};
export type AgentSpeechSettings = {settings:SpeechSettings; available:boolean; canManage:boolean};
