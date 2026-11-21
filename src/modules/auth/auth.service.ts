import { randomBytes } from 'crypto';
import { Injectable, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import { users } from '@prisma/client';
import * as argon2 from 'argon2';
import { CookieOptions, Response } from 'express';
import { AuthenticatedUser } from '../../common/decorators/current-user.decorator';
import { AppException, ErrorDetail } from '../../common/errors/app-exception';
import { SESSION_COOKIE_NAME } from '../../common/guards/auth.guard';
import { BoundedRateLimiter } from '../../common/rate-limit/bounded-rate-limiter';
import { generateOpaqueToken, sha256Hex } from '../../common/utils/crypto';
import { isValidFullName, normalizeFullName } from '../../common/utils/full-name';
import { parseNationalId } from '../../common/utils/national-id';
import { validatePasswordStrength } from '../../common/utils/password';
import { normalizePhone } from '../../common/utils/phone';
import { PrismaService } from '../../database/prisma.service';
import { lockUser, withTx } from '../../database/transaction';
import { AuditService } from '../audit/audit.service';
import { EmailService } from '../email/email.service';
import { SessionStreamRegistry } from '../notifications/session-stream-registry';
import { ChangePasswordDto } from './dto/change-password.dto';
import { ForgotPasswordDto } from './dto/forgot-password.dto';
import { LoginDto } from './dto/login.dto';
import { RegisterDto } from './dto/register.dto';
import { ResetPasswordDto } from './dto/reset-password.dto';
import { UpdateMeDto } from './dto/update-me.dto';
import { mapUserResponse, UserResponse } from './user-response.mapper';

const SESSION_MAX_AGE_SECONDS = 43_200; // 12 hours (Contract §0.9)
const FAILED_LOGIN_LIMIT = 5;
const FAILED_LOGIN_WINDOW_MS = 15 * 60 * 1000;
const FORGOT_PASSWORD_EMAIL_LIMIT = 3;
const FORGOT_PASSWORD_EMAIL_WINDOW_MS = 60 * 60 * 1000;

@Injectable()
export class AuthService implements OnModuleInit, OnModuleDestroy {
  private dummyPasswordHash = '';
  private readonly failedLoginLimiter = new BoundedRateLimiter(
    FAILED_LOGIN_LIMIT,
    FAILED_LOGIN_WINDOW_MS,
  );
  private readonly forgotPasswordEmailLimiter = new BoundedRateLimiter(
    FORGOT_PASSWORD_EMAIL_LIMIT,
    FORGOT_PASSWORD_EMAIL_WINDOW_MS,
  );

  constructor(
    private readonly prisma: PrismaService,
    private readonly jwtService: JwtService,
    private readonly configService: ConfigService,
    private readonly emailService: EmailService,
    private readonly auditService: AuditService,
    private readonly sessionStreamRegistry: SessionStreamRegistry,
  ) {}

  async onModuleInit(): Promise<void> {
    this.dummyPasswordHash = await argon2.hash(randomBytes(32).toString('hex'), {
      type: argon2.argon2id,
    });
  }

  onModuleDestroy(): void {
    this.failedLoginLimiter.destroy();
    this.forgotPasswordEmailLimiter.destroy();
  }

  /**
   * Exposed for deterministic e2e tests; never exposed over HTTP.
   */
  resetRateLimiters(): void {
    this.failedLoginLimiter.clear();
    this.forgotPasswordEmailLimiter.clear();
  }

  async register(dto: RegisterDto, res: Response): Promise<UserResponse> {
    if (dto.acceptTerms !== true) {
      throw new AppException('TERMS_NOT_ACCEPTED', 'You must accept the terms to register.', {
        field: 'acceptTerms',
      });
    }

    const parsedId = parseNationalId(dto.nationalId);
    if (!parsedId.valid) {
      throw new AppException('INVALID_NATIONAL_ID', 'National ID is invalid.', {
        field: 'nationalId',
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

    const passwordCheck = validatePasswordStrength(dto.password, {
      email: normalizedEmail,
      nationalId: dto.nationalId,
    });
    if (!passwordCheck.valid) {
      details.push({
        field: 'password',
        code: passwordCheck.code ?? 'INVALID_VALUE',
        message: passwordCheck.message ?? 'Password does not meet strength requirements.',
      });
    }

    if (details.length > 0) {
      throw new AppException('VALIDATION_ERROR', details[0].message, {
        field: details[0].field,
        details,
      });
    }

    const passwordHash = await argon2.hash(dto.password, { type: argon2.argon2id });

    const createdUser = await this.prisma.users.create({
      data: {
        role: 'CITIZEN',
        full_name: normalizedName,
        email: normalizedEmail,
        phone: normalizedPhone!,
        password_hash: passwordHash,
        national_id: dto.nationalId,
        birth_date: parsedId.birthDateObj,
        gender: parsedId.gender,
        preferred_language: dto.preferredLanguage ?? 'ar',
        is_active: true,
        must_change_password: false,
      },
    });

    await this.setSessionCookie(res, createdUser);
    return mapUserResponse(createdUser);
  }

  async login(dto: LoginDto, clientIp: string, res: Response): Promise<UserResponse> {
    const normalizedIdentifier = dto.identifier.toLowerCase();
    const limiterKey = `${clientIp}:${normalizedIdentifier}`;

    const limitCheck = this.failedLoginLimiter.check(limiterKey);
    if (!limitCheck.allowed) {
      res.setHeader('Retry-After', String(limitCheck.retryAfterSeconds));
      throw new AppException('RATE_LIMITED', 'Too many failed login attempts. Try again later.');
    }

    const user = await this.findUserByIdentifier(dto.identifier);
    const hashToVerify = user ? user.password_hash : this.dummyPasswordHash;

    let passwordMatches = false;
    try {
      passwordMatches = await argon2.verify(hashToVerify, dto.password);
    } catch {
      passwordMatches = false;
    }

    if (!user || !passwordMatches) {
      this.failedLoginLimiter.recordFailure(limiterKey);
      throw new AppException('INVALID_CREDENTIALS', 'Identifier or password is incorrect.');
    }

    // Check is_active only after password verification so account status is never enumerated.
    if (!user.is_active) {
      throw new AppException('ACCOUNT_DISABLED', 'Your account has been deactivated.');
    }

    this.failedLoginLimiter.reset(limiterKey);
    await this.setSessionCookie(res, user);
    return mapUserResponse(user);
  }

  getMe(user: AuthenticatedUser): UserResponse {
    return mapUserResponse(user);
  }

  async updateMe(user: AuthenticatedUser, dto: UpdateMeDto): Promise<UserResponse> {
    if (dto.phone === undefined && dto.preferredLanguage === undefined) {
      throw new AppException(
        'VALIDATION_ERROR',
        'At least one of phone or preferredLanguage must be provided.',
      );
    }

    const updateData: { phone?: string; preferred_language?: 'ar' | 'en' } = {};

    if (dto.phone !== undefined) {
      const normalizedPhone = normalizePhone(dto.phone);
      if (!normalizedPhone) {
        throw new AppException(
          'VALIDATION_ERROR',
          'phone must be a valid Egyptian mobile number.',
          {
            field: 'phone',
            details: [
              {
                field: 'phone',
                code: 'INVALID_FORMAT',
                message: 'phone must be a valid Egyptian mobile number.',
              },
            ],
          },
        );
      }
      updateData.phone = normalizedPhone;
    }

    if (dto.preferredLanguage !== undefined) {
      updateData.preferred_language = dto.preferredLanguage;
    }

    const updated = await this.prisma.users.update({
      where: { id: user.id },
      data: updateData,
    });

    return mapUserResponse(updated);
  }

  async logout(rawCookieToken: string | undefined, res: Response): Promise<{ loggedOut: true }> {
    this.clearSessionCookie(res);

    if (rawCookieToken) {
      try {
        const payload = await this.jwtService.verifyAsync<{ sub?: string }>(rawCookieToken, {
          algorithms: ['HS256'],
          ignoreExpiration: true,
        });
        if (payload?.sub) {
          this.sessionStreamRegistry.disconnectUser(payload.sub);
        }
      } catch {
        // Invalid or tampered tokens still succeed silently on logout (Contract §1.5).
      }
    }

    return { loggedOut: true };
  }

  async changePassword(
    user: AuthenticatedUser,
    dto: ChangePasswordDto,
    res: Response,
  ): Promise<{ changed: true }> {
    const currentMatches = await argon2.verify(user.password_hash, dto.currentPassword);
    if (!currentMatches) {
      throw new AppException('INVALID_CURRENT_PASSWORD', 'Current password is incorrect.');
    }

    if (dto.newPassword === dto.currentPassword) {
      throw new AppException(
        'PASSWORD_UNCHANGED',
        'New password must differ from the current password.',
      );
    }

    const strength = validatePasswordStrength(dto.newPassword, {
      email: user.email,
      nationalId: user.national_id,
    });
    if (!strength.valid) {
      const message = strength.message ?? 'Password does not meet strength requirements.';
      throw new AppException('VALIDATION_ERROR', message, {
        field: 'newPassword',
        details: [
          {
            field: 'newPassword',
            code: strength.code ?? 'INVALID_VALUE',
            message,
          },
        ],
      });
    }

    const newPasswordHash = await argon2.hash(dto.newPassword, { type: argon2.argon2id });

    const updatedUser = await withTx(this.prisma, async (tx) => {
      await lockUser(tx, user.id);

      const saved = await tx.users.update({
        where: { id: user.id },
        data: {
          password_hash: newPasswordHash,
          token_version: { increment: 1 },
          must_change_password: false,
        },
      });

      await this.emailService.enqueueInTx(tx, {
        toEmail: saved.email,
        toUserId: saved.id,
        template: 'PASSWORD_CHANGED',
        language: saved.preferred_language,
        payload: {},
      });

      return saved;
    });

    this.sessionStreamRegistry.disconnectUser(updatedUser.id);
    await this.setSessionCookie(res, updatedUser);

    return { changed: true };
  }

  async forgotPassword(dto: ForgotPasswordDto, res: Response): Promise<{ requested: true }> {
    const normalizedEmail = dto.email.toLowerCase();

    const emailLimit = this.forgotPasswordEmailLimiter.consume(normalizedEmail);
    if (!emailLimit.allowed) {
      res.setHeader('Retry-After', String(emailLimit.retryAfterSeconds));
      throw new AppException('RATE_LIMITED', 'Too many password reset requests. Try again later.');
    }

    const user = await this.prisma.users.findUnique({
      where: { email: normalizedEmail },
    });

    if (user && user.is_active) {
      const rawToken = generateOpaqueToken(32);
      const tokenHash = sha256Hex(rawToken);
      const frontendBaseUrl = this.configService.get<string>('FRONTEND_BASE_URL', '');
      const resetUrl = `${frontendBaseUrl}/reset-password?token=${rawToken}`;

      await withTx(this.prisma, async (tx) => {
        await lockUser(tx, user.id);

        await tx.$executeRaw`
          UPDATE password_reset_tokens
          SET used_at = now()
          WHERE user_id = ${user.id}::uuid AND used_at IS NULL
        `;

        await tx.$executeRaw`
          INSERT INTO password_reset_tokens (user_id, token_hash, expires_at)
          VALUES (${user.id}::uuid, ${tokenHash}, now() + interval '30 minutes')
        `;

        await this.emailService.enqueueInTx(tx, {
          toEmail: user.email,
          toUserId: user.id,
          template: 'PASSWORD_RESET',
          language: user.preferred_language,
          payload: { resetUrl },
        });
      });
    }

    return { requested: true };
  }

  async resetPassword(dto: ResetPasswordDto): Promise<{ reset: true }> {
    const tokenHash = sha256Hex(dto.token);

    // Pre-fetch candidate token + user outside transaction so argon2id hashing never holds DB locks.
    const candidate = await this.prisma.password_reset_tokens.findUnique({
      where: { token_hash: tokenHash },
      include: { users: true },
    });

    if (
      !candidate ||
      candidate.used_at !== null ||
      candidate.expires_at.getTime() <= Date.now() ||
      !candidate.users.is_active
    ) {
      throw new AppException('INVALID_RESET_TOKEN', 'Reset token is invalid or has expired.');
    }

    const strength = validatePasswordStrength(dto.newPassword, {
      email: candidate.users.email,
      nationalId: candidate.users.national_id,
    });
    if (!strength.valid) {
      const message = strength.message ?? 'Password does not meet strength requirements.';
      throw new AppException('VALIDATION_ERROR', message, {
        field: 'newPassword',
        details: [
          {
            field: 'newPassword',
            code: strength.code ?? 'INVALID_VALUE',
            message,
          },
        ],
      });
    }

    const newPasswordHash = await argon2.hash(dto.newPassword, { type: argon2.argon2id });

    const resetUserId = await withTx(this.prisma, async (tx) => {
      // Lock order: users -> password_reset_tokens (matches forgotPassword).
      await lockUser(tx, candidate.user_id);

      const lockedTokens = await tx.$queryRaw<
        Array<{
          id: string;
          user_id: string;
          used_at: Date | null;
          is_unexpired: boolean;
        }>
      >`
        SELECT id, user_id, used_at, (expires_at > now()) AS is_unexpired
        FROM password_reset_tokens
        WHERE token_hash = ${tokenHash}
        FOR UPDATE
      `;

      const lockedToken = lockedTokens[0];
      if (!lockedToken || lockedToken.used_at !== null || !lockedToken.is_unexpired) {
        throw new AppException('INVALID_RESET_TOKEN', 'Reset token is invalid or has expired.');
      }

      const targetUser = await tx.users.findUnique({ where: { id: lockedToken.user_id } });
      if (!targetUser || !targetUser.is_active) {
        throw new AppException('INVALID_RESET_TOKEN', 'Reset token is invalid or has expired.');
      }

      await tx.users.update({
        where: { id: targetUser.id },
        data: {
          password_hash: newPasswordHash,
          token_version: { increment: 1 },
          must_change_password: false,
        },
      });

      await tx.$executeRaw`
        UPDATE password_reset_tokens
        SET used_at = now()
        WHERE id = ${lockedToken.id}::uuid
      `;

      await this.auditService.recordInTx(tx, {
        actorId: targetUser.id,
        action: 'PASSWORD_RESET_COMPLETED',
        entityType: 'USER',
        entityId: targetUser.id,
        metadata: {},
      });

      await this.emailService.enqueueInTx(tx, {
        toEmail: targetUser.email,
        toUserId: targetUser.id,
        template: 'PASSWORD_CHANGED',
        language: targetUser.preferred_language,
        payload: {},
      });

      return targetUser.id;
    });

    this.sessionStreamRegistry.disconnectUser(resetUserId);

    return { reset: true };
  }

  private async findUserByIdentifier(identifier: string): Promise<users | null> {
    if (identifier.includes('@')) {
      return this.prisma.users.findUnique({
        where: { email: identifier.toLowerCase() },
      });
    }

    if (/^[0-9]{14}$/.test(identifier)) {
      return this.prisma.users.findUnique({
        where: { national_id: identifier },
      });
    }

    return null;
  }

  private getBaseCookieOptions(): CookieOptions {
    const nodeEnv = this.configService.get<string>('NODE_ENV', 'development');
    const sameSite = this.configService.get<'lax' | 'strict' | 'none'>('COOKIE_SAMESITE', 'lax');
    const domain = this.configService.get<string | undefined>('COOKIE_DOMAIN');

    const options: CookieOptions = {
      httpOnly: true,
      secure: nodeEnv !== 'development',
      sameSite,
      path: '/',
    };

    if (domain) {
      options.domain = domain;
    }

    return options;
  }

  private async setSessionCookie(res: Response, user: users): Promise<void> {
    const token = await this.jwtService.signAsync(
      { sub: user.id, tv: user.token_version },
      { algorithm: 'HS256', expiresIn: SESSION_MAX_AGE_SECONDS },
    );

    res.cookie(SESSION_COOKIE_NAME, token, {
      ...this.getBaseCookieOptions(),
      maxAge: SESSION_MAX_AGE_SECONDS * 1000,
    });
  }

  private clearSessionCookie(res: Response): void {
    res.clearCookie(SESSION_COOKIE_NAME, this.getBaseCookieOptions());
  }
}
