export const TOEVOEGEN = 'toevoegen';
export const AANPASSEN = 'aanpassen';
export const VERWIJDERD = 'verwijderd';   // soft delete: record krijgt VERWIJDERD = true
export const HERSTEL = 'herstel';         // soft delete ongedaan gemaakt
export const ELIMINEER = 'elimineer';     // record definitief verwijderd

export type HeliosMqttType =
   | typeof TOEVOEGEN
   | typeof AANPASSEN
   | typeof VERWIJDERD
   | typeof HERSTEL
   | typeof ELIMINEER;

export interface RawMqttMessage {
   type: HeliosMqttType;
   table: string;
   data: RawHeliosMqttData;
   timestamp: string;
}

export interface RawHeliosMqttData {
   voor?: Record<string, unknown>[];
   data?: Record<string, unknown>;
   resultaat?: Record<string, unknown>[];
   record_id?: number;
}
