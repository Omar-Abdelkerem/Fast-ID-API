import { Body, Controller, HttpCode, HttpStatus, Param, Post } from '@nestjs/common';
import { AuthenticatedUser, CurrentUser } from '../../common/decorators/current-user.decorator';
import { Roles } from '../../common/decorators/roles.decorator';
import { CredentialResponse } from './credential-response.mapper';
import { CredentialsService } from './credentials.service';
import { RevokeCredentialDto } from './dto/revoke-credential.dto';

@Roles('ADMIN')
@Controller('admin/credentials')
export class AdminCredentialsController {
  constructor(private readonly credentialsService: CredentialsService) {}

  @Post(':id/revoke')
  @HttpCode(HttpStatus.OK)
  async revoke(
    @CurrentUser() admin: AuthenticatedUser,
    @Param('id') id: string,
    @Body() dto: RevokeCredentialDto,
  ): Promise<CredentialResponse> {
    return this.credentialsService.revoke(admin, id, dto.reason);
  }
}
