import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { AuthenticatedUser } from '../../common/decorators/current-user.decorator';
import { createPaginatedResult, PaginatedResult } from '../../common/dto/pagination.dto';
import { AppException } from '../../common/errors/app-exception';
import { isUuid } from '../../common/utils/uuid';
import { PrismaService } from '../../database/prisma.service';
import { lockUser, withTx } from '../../database/transaction';
import { AuditService } from '../audit/audit.service';
import { SessionStreamRegistry } from '../notifications/session-stream-registry';
import { AdminCitizenResponse, mapAdminCitizenResponse } from './citizen-response.mapper';
import { ListCitizensQueryDto } from './dto/list-citizens-query.dto';
import { UpdateCitizenDto } from './dto/update-citizen.dto';

@Injectable()
export class AdminCitizensService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly auditService: AuditService,
    private readonly sessionStreamRegistry: SessionStreamRegistry,
  ) {}

  async list(query: ListCitizensQueryDto): Promise<PaginatedResult<AdminCitizenResponse>> {
    const andClauses: Prisma.usersWhereInput[] = [{ role: 'CITIZEN' }];

    if (query.isActive !== undefined) {
      andClauses.push({ is_active: query.isActive === 'true' });
    }

    if (query.q) {
      const q = query.q.trim();
      const orSearch: Prisma.usersWhereInput[] = [
        { full_name: { contains: q, mode: 'insensitive' } },
        { email: { contains: q, mode: 'insensitive' } },
      ];
      if (/^[0-9]{14}$/.test(q)) {
        orSearch.push({ national_id: q });
      }
      andClauses.push({ OR: orSearch });
    }

    const where: Prisma.usersWhereInput = { AND: andClauses };
    const orderBy: Prisma.usersOrderByWithRelationInput[] =
      query.sort === 'createdAt'
        ? [{ created_at: 'asc' }, { id: 'asc' }]
        : [{ created_at: 'desc' }, { id: 'desc' }];

    const skip = (query.page - 1) * query.pageSize;

    const [total, rows] = await Promise.all([
      this.prisma.users.count({ where }),
      this.prisma.users.findMany({
        where,
        orderBy,
        skip,
        take: query.pageSize,
      }),
    ]);

    return createPaginatedResult(
      rows.map(mapAdminCitizenResponse),
      total,
      query.page,
      query.pageSize,
    );
  }

  async update(
    admin: AuthenticatedUser,
    id: string,
    dto: UpdateCitizenDto,
  ): Promise<AdminCitizenResponse> {
    if (!isUuid(id)) {
      throw new AppException('USER_NOT_FOUND', 'Citizen account not found.');
    }

    const updated = await withTx(this.prisma, async (tx) => {
      const exists = await lockUser(tx, id);
      if (!exists) {
        throw new AppException('USER_NOT_FOUND', 'Citizen account not found.');
      }

      const target = await tx.users.findUniqueOrThrow({ where: { id } });
      if (target.role !== 'CITIZEN') {
        throw new AppException('USER_NOT_FOUND', 'Citizen account not found.');
      }

      const next = await tx.users.update({
        where: { id: target.id },
        data: {
          is_active: dto.isActive,
          ...(dto.isActive === false ? { token_version: { increment: 1 } } : {}),
        },
      });

      await this.auditService.recordInTx(tx, {
        actorId: admin.id,
        action: dto.isActive ? 'CITIZEN_REACTIVATED' : 'CITIZEN_DEACTIVATED',
        entityType: 'USER',
        entityId: next.id,
        metadata: {
          fromIsActive: target.is_active,
          toIsActive: dto.isActive,
        },
      });

      return next;
    });

    if (dto.isActive === false) {
      this.sessionStreamRegistry.disconnectUser(updated.id);
    }

    return mapAdminCitizenResponse(updated);
  }
}
