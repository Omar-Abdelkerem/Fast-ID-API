import { Controller, Get, Param } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { Public } from '../../common/decorators/public.decorator';
import { VerifyCredentialResponse } from './credential-response.mapper';
import { CredentialsService } from './credentials.service';

@Controller('verify')
export class VerifyController {
  constructor(private readonly credentialsService: CredentialsService) {}

  @Public()
  @Throttle({ default: { limit: 30, ttl: 60_000 } })
  @Get(':qrToken')
  async verify(@Param('qrToken') qrToken: string): Promise<VerifyCredentialResponse> {
    return this.credentialsService.verifyByQrToken(qrToken);
  }
}
