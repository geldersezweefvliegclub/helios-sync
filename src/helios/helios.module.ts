import { Module } from '@nestjs/common';
import { ApiService } from './apiservice/api.service';
import { LoginService } from './apiservice/login.service';
import { LedenService } from './apiservice/leden.service';
import { VliegtuigenService } from './apiservice/vliegtuigen.service';

@Module({
  providers: [ApiService, LoginService, LedenService, VliegtuigenService],
  exports: [ApiService, LoginService, LedenService, VliegtuigenService],
})
export class HeliosModule {}