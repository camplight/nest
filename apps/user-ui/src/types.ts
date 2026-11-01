export type ChannelParticipant = {
  subscriberType: string;
  subscriberId: string;
};

export type ChannelShare = {
  viewerType: string;
  viewerId: string;
};

export type Channel = {
  id: string;
  name: string;
  description?: string | null;
  kind?: string;
  visibility?: "PUBLIC" | "PRIVATE";
  ownerHumanId?: string | null;
  archivedAt?: number | null;
  participants?: ChannelParticipant[];
  shares?: ChannelShare[];
  canPost?: boolean;
  canManage?: boolean;
};

export type Agent = {
  mode?: "CLASSIC" | "WRAPPED";
  modelId?: string;
  modelCapabilities?: { realtimeAudioInput?: boolean; realtimeAudioOutput?: boolean };
  icon?: string | null;
  id?: string;
  name: string;
  description?: string | null;
  visibility?: "PUBLIC" | "PRIVATE";
  ownerHumanId?: string | null;
  runtimeState?: string;
  lastStartedAt?: number | null;
  desiredState?: string;
  updatedAt?: number;
};

export type EventRow = {
  id: string;
  type: string;
  source: string;
  createdAt?: number;
  deliverAt?: number;
  channelId?: string;
  payload?: unknown;
  payloadTruncated?: boolean;
  status?: string;
};

export type AuthMe = {
  id?: string | null;
  username?: string | null;
  mustChangePassword?: boolean;
};

export type Team = {
  id: string;
  name: string;
};
