import { Module } from '@nestjs/common';
import { SynapseAuthService } from './synapse-auth.service';
import { SynapseApiService } from './synapse-api.service';
import { SynapseRoomsService } from './synapse-rooms.service';
import { SynapseWorker } from './synapse.worker';
import { GoogleModule } from '../google/google.module';
import { ErrorMailService } from '../common/error-mail.service';

@Module({
  imports: [GoogleModule],
  providers: [SynapseAuthService, SynapseApiService, SynapseRoomsService, SynapseWorker, ErrorMailService],
})
export class SynapseModule {}
