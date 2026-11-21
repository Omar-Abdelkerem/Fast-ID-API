import { Body, Controller, Patch } from '@nestjs/common';
import { AuthenticatedUser, CurrentUser } from '../../common/decorators/current-user.decorator';
import { Roles } from '../../common/decorators/roles.decorator';
import { SettingsResponse, SettingsService } from './settings.service';

@Roles('ADMIN')
@Controller('admin/settings')
export class AdminSettingsController {
  constructor(private readonly settingsService: SettingsService) {}

  @Patch()
  async updateSettings(
    @CurrentUser() admin: AuthenticatedUser,
    @Body() body: Record<string, unknown>,
  ): Promise<SettingsResponse> {
    return this.settingsService.updateSettings(admin.id, body);
  }
}
