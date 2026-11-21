import { Controller, Get, Param, Query } from '@nestjs/common';
import { PublicCache } from '../../common/decorators/public-cache.decorator';
import { Public } from '../../common/decorators/public.decorator';
import { PublicServiceResponse, ServiceSummaryResponse } from './service-definition.types';
import { ServicesService } from './services.service';

@Controller('services')
export class ServicesController {
  constructor(private readonly servicesService: ServicesService) {}

  @Public()
  @PublicCache(60, 300)
  @Get()
  async listPublished(@Query('category') category?: string): Promise<ServiceSummaryResponse[]> {
    return this.servicesService.listPublished(category);
  }

  @Public()
  @PublicCache(60, 300)
  @Get(':id')
  async getPublished(@Param('id') id: string): Promise<PublicServiceResponse> {
    return this.servicesService.getPublishedById(id);
  }
}
