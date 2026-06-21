import { HeliosMqttType } from './mqtt.types';

export const MQTT_STARTLIJST  = 'mqtt.startlijst';
export const MQTT_LEDEN       = 'mqtt.leden';
export const MQTT_VLIEGTUIGEN = 'mqtt.vliegtuigen';
export const MQTT_DAGINFO     = 'mqtt.daginfo';
export const MQTT_AANWEZIG    = 'mqtt.aanwezig_vliegtuig';
export const MQTT_SYNC        = 'mqtt.sync';

export class HeliosMqttEvent {
  constructor(
     public readonly type: HeliosMqttType,
     public readonly voor: Record<string, unknown> | null,
     public readonly resultaat: Record<string, unknown> | null,
     public readonly recordId: number | undefined,
  ) {}
}


export class SyncMqttEvent {
  public readonly type: HeliosMqttType;
  public readonly data: import('../helios/helios.leden').LidRecord;
}