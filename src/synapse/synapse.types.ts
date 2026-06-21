export interface SynapseTokenResponse {
  access_token: string;
  refresh_token?: string;
  expires_in_ms?: number;
  expires_in?: number;
}

export interface StoredToken extends SynapseTokenResponse {
  expires_at: number;
}

export interface SynapseUser {
  name: string;
  displayname?: string;
  admin: boolean;
  deactivated: boolean;
  locked?: boolean;
  avatar_url?: string;
  threepids?: Array<{ medium: string; address: string }>;
  user_type?: string | null;
}

export interface SynapseRoomListResponse {
  rooms: SynapseRoom[];
  total_rooms?: number;
}

export interface SynapseRoom {
  room_id: string;
  name?: string;
  canonical_alias?: string;
  joined_members?: number;
}

export interface SynapseRoomMembersResponse {
  members: string[];
  total?: number;
}

export interface RoomsConfig {
  kamers: Record<string, string[]>;
  favorieten: string[];
}
