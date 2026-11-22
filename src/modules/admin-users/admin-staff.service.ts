import { Injectable } from '@nestjs/common';
import { governorate, Prisma } from '@prisma/client';
import * as argon2 from 'argon2';
import { AuthenticatedUser } from '../../common/decorators/current-user.decorator';
import { createPaginatedResult, PaginatedResult } from '../../common/dto/pagination.dto';
import { AppException, ErrorDetail } from '../../common/errors/app-exception';
import { isValidFullName, normalizeFullName } from '../../common/utils/full-name';
import { validatePasswordStrength } from '../../common/utils/password';
import { normalizePhone } from '../../common/utils/phone';
import { isUuid } from '../../common/utils/uuid';
import { PrismaService } from '../../database/prisma.service';
import { acquireAdvisoryXactLock, lockUser, withTx } from '../../database/transaction';
import { AuditService } from '../audit/audit.service';
import { mapUserResponse, UserResponse } from '../auth/user-response.mapper';
import { SessionStreamRegistry } from '../notifications/session-stream-registry';
import { GOVERNORATE_BY_CODE } from '../reference/governorates.data';
import { CreateStaffDto } from './dto/create-staff.dto';
import { ListStaffQueryDto } from './dto/list-staff-query.dto';
import { UpdateStaffDto } from './dto/update-staff.dto';

function isValidGovernorate(code: string): code is governorate {
  return GOVERNORATE_BY_CODE.has(code as governorate);
}

@Injectable()
export class AdminStaffService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly auditService: AuditService,
    private readonly sessionStreamRegistry: SessionStreamRegistry,
  ) {}

  async create(admin: AuthenticatedUser, dto: CreateStaffDto): Promise<UserResponse> {
    if (dto.role === 'ADMIN' && dto.governorate !== undefined) {
      throw new AppException('GOVERNORATE_NOT_ALLOWED', 'Governorate is forbidden for ADMIN.', {
        field: 'governorate',
      });
    }

    const normalizedEmail = dto.email.toLowerCase();
    const normalizedName = normalizeFullName(dto.fullName);
    const normalizedPhone = normalizePhone(dto.phone);
    const details: ErrorDetail[] = [];

    if (!isValidFullName(normalizedName)) {
      details.push({
        field: 'fullName',
        code: 'INVALID_FORMAT',
        message: 'fullName must be 3-100 characters with at least two Arabic or Latin words.',
      });
    }

    if (!normalizedPhone) {
      details.push({
        field: 'phone',
        code: 'INVALID_FORMAT',
        message: 'phone must be a valid Egyptian mobile number.',
      });
    }

    let resolvedGovernorate: governorate | null = null;
    if (dto.role === 'AGENT') {
      if (!dto.governorate) {
        details.push({
          field: 'governorate',
          code: 'REQUIRED',
          message: 'governorate is required for AGENT accounts.',
        });
      } else if (!isValidGovernorate(dto.governorate)) {
        details.push({
          field: 'governorate',
          code: 'INVALID_VALUE',
          message: 'governorate must be a valid Egyptian governorate code.',
        });
      } else {
        resolvedGovernorate = dto.governorate;
      }
    }

    const passwordCheck = validatePasswordStrength(dto.temporaryPassword, {
      email: normalizedEmail,
    });
    if (!passwordCheck.valid) {
      details.push({
        field: 'temporaryPassword',
        code: passwordCheck.code ?? 'INVALID_VALUE',
        message: passwordCheck.message ?? 'Temporary password does not meet strength requirements.',
      });
    }

    if (details.length > 0) {
      throw new AppException('VALIDATION_ERROR', 'Validation failed.', {
        field: details[0].field,
        details,
      });
    }

    const passwordHash = await argon2.hash(dto.temporaryPassword, {
      type: argon2.argon2id,
    });

    const created = await withTx(this.prisma, async (tx) => {
      const existing = await tx.users.findUnique({
        where: { email: normalizedEmail },
        select: { id: true },
      });
      if (existing) {
        throw new AppException('EMAIL_ALREADY_REGISTERED', 'Email is already registered.', {
          field: 'email',
        });
      }

      const staff = await tx.users.create({
        data: {
          role: dto.role,
          full_name: normalizedName,
          email: normalizedEmail,
          phone: normalizedPhone!,
          password_hash: passwordHash,
          governorate: resolvedGovernorate,
          preferred_language: 'ar',
          is_active: true,
          must_change_password: true,
        },
      });

      await this.auditService.recordInTx(tx, {
        actorId: admin.id,
        action: 'STAFF_CREATED',
        entityType: 'USER',
        entityId: staff.id,
        metadata: {
          role: staff.role,
          ...(staff.governorate ? { governorate: staff.governorate } : {}),
        },
      });

      return staff;
    });

    return mapUserResponse(created);
  }

  async list(query: ListStaffQueryDto): Promise<PaginatedResult<UserResponse>> {
    const andClauses: Prisma.usersWhereInput[] = [
      { role: query.role ? query.role : { in: ['ADMIN', 'AGENT'] } },
    ];

    if (query.isActive !== undefined) {
      andClauses.push({ is_active: query.isActive === 'true' });
    }

    if (query.q) {
      const q = query.q.trim();
      andClauses.push({
        OR: [
          { full_name: { contains: q, mode: 'insensitive' } },
          { email: { contains: q, mode: 'insensitive' } },
        ],
      });
    }

    const where: Prisma.usersWhereInput = { AND: andClauses };
    const orderBy: Prisma.usersOrderByWithRelationInput[] =
      query.sort === 'createdAt'
        ? [{ created_at: 'asc' }, { id: 'asc' }]
        : query.sort === 'fullName'
          ? [{ full_name: 'asc' }, { id: 'asc' }]
          : query.sort === '-fullName'
            ? [{ full_name: 'desc' }, { id: 'desc' }]
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

    return createPaginatedResult(rows.map(mapUserResponse), total, query.page, query.pageSize);
  }

  async update(admin: AuthenticatedUser, id: string, dto: UpdateStaffDto): Promise<UserResponse> {
    if (!isUuid(id)) {
      throw new AppException('USER_NOT_FOUND', 'Staff user not found.');
    }

    const hasFullName = dto.fullName !== undefined;
    const hasPhone = dto.phone !== undefined;
    const hasGovernorate = dto.governorate !== undefined;
    const hasIsActive = dto.isActive !== undefined;

    if (!hasFullName && !hasPhone && !hasGovernorate && !hasIsActive) {
      throw new AppException('VALIDATION_ERROR', 'At least one field must be provided.');
    }

    const details: ErrorDetail[] = [];
    let normalizedName: string | undefined;
    if (hasFullName) {
      if (typeof dto.fullName !== 'string') {
        details.push({
          field: 'fullName',
          code: 'INVALID_TYPE',
          message: 'fullName must be a string.',
        });
      } else {
        normalizedName = normalizeFullName(dto.fullName);
        if (!isValidFullName(normalizedName)) {
          details.push({
            field: 'fullName',
            code: 'INVALID_FORMAT',
            message: 'fullName must be 3-100 characters with at least two Arabic or Latin words.',
          });
        }
      }
    }

    let normalizedPhone: string | undefined;
    if (hasPhone) {
      if (typeof dto.phone !== 'string') {
        details.push({
          field: 'phone',
          code: 'INVALID_TYPE',
          message: 'phone must be a string.',
        });
      } else {
        const parsed = normalizePhone(dto.phone);
        if (!parsed) {
          details.push({
            field: 'phone',
            code: 'INVALID_FORMAT',
            message: 'phone must be a valid Egyptian mobile number.',
          });
        } else {
          normalizedPhone = parsed;
        }
      }
    }

    if (hasIsActive && typeof dto.isActive !== 'boolean') {
      details.push({
        field: 'isActive',
        code: 'INVALID_TYPE',
        message: 'isActive must be a boolean.',
      });
    }

    if (details.length > 0) {
      throw new AppException('VALIDATION_ERROR', 'Validation failed.', {
        field: details[0].field,
        details,
      });
    }

    const result = await withTx(this.prisma, async (tx) => {
      // Lock order (Design §6.2, D-25): users -> advisory locks (assign:<gov>, staff:admin_active)
      const exists = await lockUser(tx, id);
      if (!exists) {
        throw new AppException('USER_NOT_FOUND', 'Staff user not found.');
      }

      const target = await tx.users.findUniqueOrThrow({ where: { id } });
      if (target.role !== 'ADMIN' && target.role !== 'AGENT') {
        throw new AppException('USER_NOT_FOUND', 'Staff user not found.');
      }

      if (hasIsActive && target.id === admin.id) {
        throw new AppException(
          'CANNOT_MODIFY_SELF',
          'An administrator cannot change their own active status.',
        );
      }

      if (hasGovernorate) {
        if (target.role === 'ADMIN') {
          throw new AppException(
            'GOVERNORATE_NOT_ALLOWED',
            'Governorate cannot be set on an ADMIN account.',
            { field: 'governorate' },
          );
        }
        if (typeof dto.governorate !== 'string' || !isValidGovernorate(dto.governorate)) {
          throw new AppException('VALIDATION_ERROR', 'Invalid governorate code.', {
            field: 'governorate',
            details: [
              {
                field: 'governorate',
                code: 'INVALID_VALUE',
                message: 'governorate must be a valid Egyptian governorate code.',
              },
            ],
          });
        }
      }

      const isDeactivating = hasIsActive && dto.isActive === false;

      if (isDeactivating && target.role === 'ADMIN' && target.is_active) {
        await acquireAdvisoryXactLock(tx, 'staff:admin_active');
        const activeAdminCount = await tx.users.count({
          where: { role: 'ADMIN', is_active: true },
        });
        if (activeAdminCount <= 1) {
          throw new AppException('LAST_ADMIN', 'Cannot deactivate the last active administrator.');
        }
      }

      if (isDeactivating && target.role === 'AGENT' && target.governorate) {
        // D-25: serialize with concurrent approve auto-assign and manual assign in this governorate
        await acquireAdvisoryXactLock(tx, `assign:${target.governorate}`);
        const activeDeliveries = await tx.deliveries.count({
          where: {
            agent_id: target.id,
            status: { in: ['ASSIGNED', 'OUT_FOR_DELIVERY'] },
          },
        });
        if (activeDeliveries > 0) {
          throw new AppException(
            'AGENT_HAS_ACTIVE_DELIVERIES',
            'Cannot deactivate an agent with assigned or out-for-delivery shipments.',
          );
        }
      }

      const changedFields: string[] = [];
      const updateData: Prisma.usersUpdateInput = {};

      if (normalizedName !== undefined) {
        updateData.full_name = normalizedName;
        changedFields.push('fullName');
      }
      if (normalizedPhone !== undefined) {
        updateData.phone = normalizedPhone;
        changedFields.push('phone');
      }
      if (hasGovernorate && dto.governorate) {
        updateData.governorate = dto.governorate as governorate;
        changedFields.push('governorate');
      }
      if (hasIsActive && dto.isActive !== undefined) {
        updateData.is_active = dto.isActive;
        changedFields.push('isActive');
        if (dto.isActive === false) {
          updateData.token_version = { increment: 1 };
        }
      }

      const updated = await tx.users.update({
        where: { id: target.id },
        data: updateData,
      });

      await this.auditService.recordInTx(tx, {
        actorId: admin.id,
        action: 'STAFF_UPDATED',
        entityType: 'USER',
        entityId: updated.id,
        metadata: {
          changedFields,
          ...(hasIsActive ? { isActive: updated.is_active } : {}),
        },
      });

      return { updated, shouldDisconnectSse: isDeactivating };
    });

    if (result.shouldDisconnectSse) {
      this.sessionStreamRegistry.disconnectUser(result.updated.id);
    }

    return mapUserResponse(result.updated);
  }
}
