export type HeliosMqttType = 'aanpassen' | 'toevoegen' | 'verwijderen';

export interface RawMqttMessage {
   type: HeliosMqttType;
   table: string;
   data: RawHeliosMqttData | RawSyncMqttData;
   timestamp: string;
}

export interface RawHeliosMqttData {
   voor?: Record<string, unknown>[];
   data?: Record<string, unknown>;
   resultaat?: Record<string, unknown>[];
   record_id?: number;
}

export interface RawSyncMqttData {
  type: string;
  table: string;
  data: string;
  timestamp: string;
}
