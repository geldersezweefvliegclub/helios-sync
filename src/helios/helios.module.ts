import { Module } from '@nestjs/common';
import { ApiService } from './apiservice/api.service';
import { LoginService } from './apiservice/login.service';
import { LedenService } from './apiservice/leden.service';

@Module({
  providers: [ApiService, LoginService, LedenService],
  exports: [ApiService, LoginService, LedenService],
})
export class HeliosModule {}