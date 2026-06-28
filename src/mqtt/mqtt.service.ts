import { Injectable, Logger, OnApplicationBootstrap, OnApplicationShutdown } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { EventEmitter2 } from '@nestjs/event-emitter';
import * as mqtt from 'mqtt';
import { RawMqttMessage, RawSyncMqttData } from './mqtt.types';
import { MQTT_LEDEN, MQTT_STARTLIJST, MQTT_AANWEZIG, MQTT_DAGINFO, MQTT_VLIEGTUIGEN, MQTT_SYNC, HeliosMqttEvent } from './mqtt.events';
import { LidRecord } from '../helios/helios.leden';

@Injectable()
export class MqttService implements OnApplicationBootstrap, OnApplicationShutdown {
  private readonly logger = new Logger(MqttService.name);
  private client!: mqtt.MqttClient;

  constructor(
     private readonly configService: ConfigService,
     private readonly eventEmitter: EventEmitter2,
  ) {}

  onApplicationBootstrap(): void {
    const brokerUrl = this.configService.get<string>('MQTT_BROKER_URL');
    if (!brokerUrl) {
      this.logger.warn('MQTT_BROKER_URL not set, MQTT disabled');
      return;
    }

    const topic    = this.configService.get<string>('MQTT_TOPIC');
    const username = this.configService.get<string>('MQTT_USERNAME') || undefined;
    const password = this.configService.get<string>('MQTT_PASSWORD') || undefined;

    this.client = mqtt.connect(brokerUrl, { username, password });

    this.client.on('connect', () => {
      this.logger.log(`Connected to MQTT broker: ${brokerUrl}`);
      this.client.subscribe(topic, (err) => {
        if (err) {
          this.logger.error(`Failed to subscribe to ${topic}: ${err.message}`);
        } else {
          this.logger.log(`Subscribed to topic: ${topic}`);
        }
      });
    });

    this.client.on('message', (receivedTopic, payload) => {
      this.handleMessage(receivedTopic, payload);
    });

    this.client.on('error', (err) => {
      this.logger.error(`MQTT error: ${err.message}`);
    });

    this.client.on('disconnect', () => {
      this.logger.warn('MQTT connection lost');
    });
  }

  onApplicationShutdown(): void {
    this.client?.end();
  }

  private handleMessage(topic: string, payload: Buffer): void
  {
    switch (topic) {
      case "gezc/helios" : this.handleHeliosMessage(topic, payload); break;
      case "gezc/sync":  this.handleSyncMessage(topic, payload); break;
      default:
        this.logger.debug(`No handler for topic: ${topic}`);
    }
  }

  private handleHeliosMessage(topic: string,payload: Buffer): void {
    let raw: RawMqttMessage;
    try {
      raw = JSON.parse(payload.toString());
    } catch {
      this.logger.error(`Invalid JSON on ${topic}: ${payload.toString()}`);
      return;
    }

    const data = raw.data as import('./mqtt.types').RawHeliosMqttData;
    this.logger.verbose(`MQTT: ${raw.type} on ${raw.table} (id: ${data.record_id})`);

    const event = new HeliosMqttEvent(
       raw.type,
       (data.voor?.[0]      ?? null) as Record<string, unknown> | null,
       (data.resultaat?.[0] ?? null) as Record<string, unknown> | null,
       data.record_id,
    );

    switch (raw.table) {
      case 'oper_startlijst':        this.eventEmitter.emit(MQTT_STARTLIJST,  event); break;
      case 'ref_vliegtuigen':        this.eventEmitter.emit(MQTT_VLIEGTUIGEN, event); break;
      case 'oper_daginfo':           this.eventEmitter.emit(MQTT_DAGINFO,     event); break;
      case 'oper_aanwezig_vliegtuig':this.eventEmitter.emit(MQTT_AANWEZIG,    event); break;
      case 'ref_leden':              this.eventEmitter.emit(MQTT_LEDEN,       event); break;
      default:
        this.logger.debug(`No handler for table: ${raw.table}`);
    }
  }

  private handleSyncMessage(topic: string,payload: Buffer): void {
    let raw: RawSyncMqttData;
    try {
      raw = JSON.parse(payload.toString());
    } catch {
      this.logger.error(`Invalid JSON on ${topic}: ${payload.toString()}`);
      return;
    }

    const lid = JSON.parse(raw.data) as LidRecord;
    this.logger.log(`MQTT sync: ${lid.NAAM} (ID=${lid.ID})`);
    this.eventEmitter.emit(MQTT_SYNC, lid);
  }
}
