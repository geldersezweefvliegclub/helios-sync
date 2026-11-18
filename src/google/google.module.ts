import { Module } from '@nestjs/common';
import { GoogleMailService } from './google.mail.service';
import { GoogleAccountService } from './google.account.service';
import { GoogleWorker } from './google.worker';
import { HeliosModule } from '../helios/helios.module';
import { ErrorMailService } from '../common/error-mail.service';

@Module({
  imports: [HeliosModule],
  providers: [GoogleMailService, GoogleAccountService, GoogleWorker, ErrorMailService],
  exports: [GoogleMailService, GoogleAccountService],
})
export class GoogleModule {}
