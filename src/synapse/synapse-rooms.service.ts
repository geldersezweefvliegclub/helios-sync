import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as fs from 'node:fs';
import { SynapseApiService } from './synapse-api.service';
import { SynapseRoomListResponse, SynapseRoomMembersResponse, RoomsConfig } from './synapse.types';
import {ErrorMailService} from "../common/error-mail.service";

@Injectable()
export class SynapseRoomsService {
  private readonly logger = new Logger(SynapseRoomsService.name);
  private roomMapping: Record<string, string> = {};
  private mappingLoaded = false;

  constructor(
    private readonly api: SynapseApiService,
    private readonly configService: ConfigService,
    private readonly errorMailService: ErrorMailService
  ) {}

  loadRoomsConfig(): RoomsConfig {
    const configPath = this.configService.get<string>('SYNAPSE_ROOMS_CONFIG', './synapse-rooms.json');
    if (!fs.existsSync(configPath)) {
      throw new Error(`Synapse rooms config not found: ${configPath}`);
    }
    return JSON.parse(fs.readFileSync(configPath, 'utf-8')) as RoomsConfig;
  }

  async ensureRoomMapping(): Promise<void> {
    if (this.mappingLoaded) return;
    await this.buildRoomMapping();
  }

  async buildRoomMapping(): Promise<void> {
    this.logger.debug('Building room mapping from Synapse');
    const data = await this.api.get<SynapseRoomListResponse>('_synapse/admin/v1/rooms');
    this.roomMapping = {};
    for (const room of data.rooms ?? []) {
      if (room.name) {
        this.roomMapping[room.name] = room.room_id;
      }
    }
    this.mappingLoaded = true;
    this.logger.debug(`Room mapping built: ${Object.keys(this.roomMapping).length} rooms`);
  }

  async addUserToRooms(roomNames: string[], matrixUserId: string): Promise<void> {
    for (const roomName of roomNames) {
      const roomId = this.roomMapping[roomName];
      if (!roomId) {
        this.logger.warn(`Room not found in mapping: ${roomName}`);
        await this.errorMailService.sendSyncError(
           `kamer mapping mislukt voor kamer:${roomName}`,
           "beschikbare kamers : " + JSON.stringify(roomId));
        continue;
      }

      const alreadyMember = await this.isInRoom(roomId, matrixUserId);
      if (alreadyMember) {
        this.logger.debug(`User ${matrixUserId} already in room ${roomName}`);
        continue;
      }

      await this.addUserToRoom(roomId, matrixUserId);
    }
  }

  async isInRoom(roomId: string, userId: string): Promise<boolean> {
    const data = await this.api.get<SynapseRoomMembersResponse>(
      `_synapse/admin/v1/rooms/${encodeURIComponent(roomId)}/members`,
    );
    return (data.members ?? []).includes(userId);
  }

  private async addUserToRoom(roomId: string, userId: string): Promise<void> {
    this.logger.debug(`Adding ${userId} to room ${roomId}`);
    await this.api.post(
      `_synapse/admin/v1/join/${encodeURIComponent(roomId)}`,
      { user_id: userId },
    );
  }

  async markRoomsAsFavorite(
    roomNames: string[],
    matrixUserId: string,
    userToken: string,
  ): Promise<void> {
    for (const roomName of roomNames) {
      const roomId = this.roomMapping[roomName];
      if (!roomId) {
        this.logger.warn(`Favorite room not found in mapping: ${roomName}`);
        continue;
      }

      const path = `_matrix/client/v3/user/${encodeURIComponent(matrixUserId)}/rooms/${encodeURIComponent(roomId)}/tags/m.favourite`;
      this.logger.debug(`Marking ${roomName} as favorite for ${matrixUserId}`);

      try {
        await this.api.put(path, {}, userToken);
      } catch (err) {
        this.logger.warn(`Failed to mark ${roomName} as favorite: ${err}`);
      }
    }
  }
}
