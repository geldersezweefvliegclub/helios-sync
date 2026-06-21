import { Module } from '@nestjs/common';
import { EboekhoudenApiService } from './eboekhouden-api.service';
import { EboekhoudenWorker } from './eboekhouden.worker';
import { ErrorMailService } from '../common/error-mail.service';
import { GoogleModule } from '../google/google.module';
import { HeliosModule } from '../helios/helios.module';

@Module({
  imports: [GoogleModule, HeliosModule],
  providers: [EboekhoudenApiService, EboekhoudenWorker, ErrorMailService],
})
export class EboekhoudenModule {}
