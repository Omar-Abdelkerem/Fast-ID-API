import { Controller, Get } from '@nestjs/common';
import { PublicCache } from '../../common/decorators/public-cache.decorator';
import { Public } from '../../common/decorators/public.decorator';
import { GovernorateItem, GOVERNORATES } from './governorates.data';

@Controller('reference')
export class ReferenceController {
  @Public()
  @PublicCache(86400)
  @Get('governorates')
  getGovernorates(): readonly GovernorateItem[] {
    return GOVERNORATES;
  }
}
