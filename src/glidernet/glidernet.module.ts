import { Module } from '@nestjs/common';
import { GlidernetWorker } from './glidernet.worker';
import { ErrorMailService } from '../common/error-mail.service';
import { GoogleModule } from '../google/google.module';
import { HeliosModule } from '../helios/helios.module';

@Module({
  imports: [GoogleModule, HeliosModule],
  providers: [GlidernetWorker, ErrorMailService],
})
export class GlidernetModule {}
