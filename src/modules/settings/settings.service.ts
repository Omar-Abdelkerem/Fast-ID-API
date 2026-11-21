import { Prisma, settings } from '@prisma/client';
import { Injectable } from '@nestjs/common';
import { AppException, ErrorDetail } from '../../common/errors/app-exception';
import { normalizePhone } from '../../common/utils/phone';
import { PrismaService } from '../../database/prisma.service';
import { withTx } from '../../database/transaction';
import { AuditService } from '../audit/audit.service';

export interface LocalizedText {
  ar: string;
  en: string;
}

export interface SettingsResponse {
  id: 'singleton';
  supportEmail: string | null;
  supportPhone: string | null;
  announcement: LocalizedText | null;
  updatedAt: string;
}

const ALLOWED_SETTINGS_KEYS = new Set(['supportEmail', 'supportPhone', 'announcement']);
const ALLOWED_LOCALIZED_KEYS = new Set(['ar', 'en']);
const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function mapSettingsResponse(row: settings): SettingsResponse {
  const announcement = isPlainObject(row.announcement)
    ? {
        ar: String(row.announcement.ar ?? ''),
        en: String(row.announcement.en ?? ''),
      }
    : null;

  return {
    id: 'singleton',
    supportEmail: row.support_email ?? null,
    supportPhone: row.support_phone ?? null,
    announcement,
    updatedAt: row.updated_at.toISOString(),
  };
}

@Injectable()
export class SettingsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly auditService: AuditService,
  ) {}

  async getPublicSettings(): Promise<SettingsResponse> {
    const row = await this.prisma.settings.upsert({
      where: { id: 'singleton' },
      update: {},
      create: { id: 'singleton' },
    });
    return mapSettingsResponse(row);
  }

  async updateSettings(adminId: string, rawBody: unknown): Promise<SettingsResponse> {
    if (!isPlainObject(rawBody)) {
      throw new AppException('VALIDATION_ERROR', 'Request body must be a JSON object.');
    }

    for (const key of Object.keys(rawBody)) {
      if (!ALLOWED_SETTINGS_KEYS.has(key)) {
        throw new AppException('UNKNOWN_FIELD', `Unknown field "${key}".`, { field: key });
      }
    }

    const providedKeys = Object.keys(rawBody);
    if (providedKeys.length === 0) {
      throw new AppException(
        'VALIDATION_ERROR',
        'At least one of supportEmail, supportPhone, or announcement must be provided.',
      );
    }

    const details: ErrorDetail[] = [];
    const updateData: Prisma.settingsUncheckedUpdateInput = {
      updated_by: adminId,
    };

    if ('supportEmail' in rawBody) {
      const value = rawBody.supportEmail;
      if (value === null) {
        updateData.support_email = null;
      } else if (typeof value !== 'string') {
        details.push({
          field: 'supportEmail',
          code: 'INVALID_VALUE',
          message: 'supportEmail must be a valid email address or null.',
        });
      } else {
        const trimmed = value.trim().toLowerCase();
        if (trimmed.length === 0 || trimmed.length > 254 || !EMAIL_REGEX.test(trimmed)) {
          details.push({
            field: 'supportEmail',
            code: 'INVALID_FORMAT',
            message: 'supportEmail must be a valid email address.',
          });
        } else {
          updateData.support_email = trimmed;
        }
      }
    }

    if ('supportPhone' in rawBody) {
      const value = rawBody.supportPhone;
      if (value === null) {
        updateData.support_phone = null;
      } else if (typeof value !== 'string') {
        details.push({
          field: 'supportPhone',
          code: 'INVALID_VALUE',
          message: 'supportPhone must be a valid Egyptian mobile number or null.',
        });
      } else {
        const normalized = normalizePhone(value);
        if (!normalized) {
          details.push({
            field: 'supportPhone',
            code: 'INVALID_FORMAT',
            message: 'supportPhone must be a valid Egyptian mobile number.',
          });
        } else {
          updateData.support_phone = normalized;
        }
      }
    }

    if ('announcement' in rawBody) {
      const value = rawBody.announcement;
      if (value === null) {
        updateData.announcement = Prisma.DbNull;
      } else if (!isPlainObject(value)) {
        details.push({
          field: 'announcement',
          code: 'INVALID_VALUE',
          message: 'announcement must be a Localized object ({ ar, en }) or null.',
        });
      } else {
        for (const subKey of Object.keys(value)) {
          if (!ALLOWED_LOCALIZED_KEYS.has(subKey)) {
            throw new AppException('UNKNOWN_FIELD', `Unknown field "announcement.${subKey}".`, {
              field: `announcement.${subKey}`,
            });
          }
        }

        const arRaw = value.ar;
        const enRaw = value.en;
        const arTrimmed = typeof arRaw === 'string' ? arRaw.trim() : null;
        const enTrimmed = typeof enRaw === 'string' ? enRaw.trim() : null;

        if (!arTrimmed) {
          details.push({
            field: 'announcement.ar',
            code: 'REQUIRED',
            message: 'announcement.ar is required.',
          });
        } else if (arTrimmed.length > 300) {
          details.push({
            field: 'announcement.ar',
            code: 'TOO_LONG',
            message: 'announcement.ar must be at most 300 characters.',
          });
        }

        if (!enTrimmed) {
          details.push({
            field: 'announcement.en',
            code: 'REQUIRED',
            message: 'announcement.en is required.',
          });
        } else if (enTrimmed.length > 300) {
          details.push({
            field: 'announcement.en',
            code: 'TOO_LONG',
            message: 'announcement.en must be at most 300 characters.',
          });
        }

        if (arTrimmed && enTrimmed && arTrimmed.length <= 300 && enTrimmed.length <= 300) {
          updateData.announcement = { ar: arTrimmed, en: enTrimmed };
        }
      }
    }

    if (details.length > 0) {
      throw new AppException('VALIDATION_ERROR', details[0].message, {
        field: details[0].field,
        details,
      });
    }

    const updated = await withTx(this.prisma, async (tx) => {
      const row = await tx.settings.upsert({
        where: { id: 'singleton' },
        update: updateData,
        create: {
          id: 'singleton',
          support_email:
            typeof updateData.support_email === 'string' ? updateData.support_email : null,
          support_phone:
            typeof updateData.support_phone === 'string' ? updateData.support_phone : null,
          announcement:
            updateData.announcement === Prisma.DbNull ? Prisma.DbNull : updateData.announcement,
          updated_by: adminId,
        },
      });

      await this.auditService.recordInTx(tx, {
        actorId: adminId,
        action: 'SETTINGS_UPDATED',
        entityType: 'SETTINGS',
        entityId: 'singleton',
        metadata: { updatedFields: providedKeys },
      });

      return row;
    });

    return mapSettingsResponse(updated);
  }
}
