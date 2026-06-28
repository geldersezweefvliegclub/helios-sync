import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { EventEmitterModule } from '@nestjs/event-emitter';
import { ScheduleModule } from '@nestjs/schedule';
import * as Joi from 'joi';
import { GoogleModule } from './google/google.module';
import { MqttModule } from './mqtt/mqtt.module';
import { SynapseModule } from './synapse/synapse.module';
import { EboekhoudenModule } from './e-boekhouden/eboekhouden.module';
import { GlidernetModule } from './glidernet/glidernet.module';

@Module({
  imports: [
    EventEmitterModule.forRoot(),
    ScheduleModule.forRoot(),
    ConfigModule.forRoot({
      isGlobal: true,
      validationSchema: Joi.object({
        // MQTT
        MQTT_BROKER_URL: Joi.string().required(),
        MQTT_TOPIC: Joi.string().default('helios/sync'),
        MQTT_USERNAME: Joi.string().optional().allow(''),
        MQTT_PASSWORD: Joi.string().optional().allow(''),

        // Synapse
        SYNAPSE_URL: Joi.string().required(),
        SYNAPSE_ADMIN_USER: Joi.string().required(),
        SYNAPSE_ADMIN_PASSWORD: Joi.string().required(),
        SYNAPSE_DOMAIN: Joi.string().required(),
        SYNAPSE_TOKEN_FILE: Joi.string().default('./synapse-token.json'),
        SYNAPSE_ROOMS_CONFIG: Joi.string().default('./synapse-rooms.json'),

        // Helios API
        HELIOS_CREDENTIAL_FILE: Joi.string().optional(),

        // Google Gmail
        GOOGLE_CREDENTIALS_PATH: Joi.string().required(),
        GOOGLE_ADMIN_EMAIL: Joi.string().email().required(),

        // Error notifications
        ICT_EMAIL: Joi.string().email().default('ict@gezc.org'),
        VERZENDEN_EMAIL: Joi.string().optional().allow(''),

        // e-Boekhouden REST API
        EB_BASE_URL: Joi.string().default('https://api.e-boekhouden.nl'),
        EB_ACCESS_TOKEN: Joi.string().optional().allow(''),
        EB_SOURCE: Joi.string().default('helios'),

        // Cron schedules
        CRON_EB_BULKSYNC: Joi.string().optional(),
        CRON_SYNAPSE_BULKSYNC: Joi.string().optional(),
        CRON_GLIDERNET_BULKSYNC: Joi.string().optional(),
        CRON_TIMEZONE: Joi.string().optional(),

        // Logging
        LOGGER_SERVER_URL: Joi.string().optional(),
        LOGGER_API_KEY: Joi.string().optional(),
        INSTANCE: Joi.string().optional(),
      }),
    }),
    GoogleModule,
    SynapseModule,
    MqttModule,
    EboekhoudenModule,
    GlidernetModule,
  ],
})
export class AppModule {}
