import { Controller, Get, Param } from '@nestjs/common';
import { AuthenticatedUser, CurrentUser } from '../../common/decorators/current-user.decorator';
import { Roles } from '../../common/decorators/roles.decorator';
import { CredentialResponse } from './credential-response.mapper';
import { CredentialsService } from './credentials.service';

@Roles('CITIZEN')
@Controller('credentials')
export class CredentialsController {
  constructor(private readonly credentialsService: CredentialsService) {}

  @Get()
  async list(@CurrentUser() citizen: AuthenticatedUser): Promise<CredentialResponse[]> {
    return this.credentialsService.listForCitizen(citizen);
  }

  @Get(':id')
  async getById(
    @CurrentUser() citizen: AuthenticatedUser,
    @Param('id') id: string,
  ): Promise<CredentialResponse> {
    return this.credentialsService.getByIdForCitizen(citizen, id);
  }
}
