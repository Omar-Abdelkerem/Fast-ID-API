import { Controller, Get } from '@nestjs/common';
import { PublicCache } from '../../common/decorators/public-cache.decorator';
import { Public } from '../../common/decorators/public.decorator';
import { SettingsResponse, SettingsService } from './settings.service';

@Controller('settings')
export class SettingsController {
  constructor(private readonly settingsService: SettingsService) {}

  @Public()
  @PublicCache(60)
  @Get()
  async getSettings(): Promise<SettingsResponse> {
    return this.settingsService.getPublicSettings();
  }
}
