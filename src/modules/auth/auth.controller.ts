import { Body, Controller, Get, HttpCode, HttpStatus, Patch, Post, Req, Res } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { Request, Response } from 'express';
import { AllowMustChangePassword } from '../../common/decorators/allow-must-change-password.decorator';
import { AuthenticatedUser, CurrentUser } from '../../common/decorators/current-user.decorator';
import { Public } from '../../common/decorators/public.decorator';
import { EmptyBodyDto } from '../../common/dto/empty-body.dto';
import { SESSION_COOKIE_NAME } from '../../common/guards/auth.guard';
import { UserRateLimit } from '../../common/guards/user-rate-limit.guard';
import { AuthService } from './auth.service';
import { ChangePasswordDto } from './dto/change-password.dto';
import { ForgotPasswordDto } from './dto/forgot-password.dto';
import { LoginDto } from './dto/login.dto';
import { RegisterDto } from './dto/register.dto';
import { ResetPasswordDto } from './dto/reset-password.dto';
import { UpdateMeDto } from './dto/update-me.dto';
import { UserResponse } from './user-response.mapper';

@Controller('auth')
export class AuthController {
  constructor(private readonly authService: AuthService) {}

  @Public()
  @Throttle({ default: { limit: 5, ttl: 60 * 60_000 } })
  @Post('register')
  @HttpCode(HttpStatus.CREATED)
  async register(
    @Body() dto: RegisterDto,
    @Res({ passthrough: true }) res: Response,
  ): Promise<UserResponse> {
    return this.authService.register(dto, res);
  }

  @Public()
  @Throttle({ default: { limit: 10, ttl: 15 * 60_000 } })
  @Post('login')
  @HttpCode(HttpStatus.OK)
  async login(
    @Body() dto: LoginDto,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ): Promise<UserResponse> {
    const clientIp = req.ip || req.socket?.remoteAddress || 'unknown';
    return this.authService.login(dto, clientIp, res);
  }

  @AllowMustChangePassword()
  @Get('me')
  getMe(@CurrentUser() user: AuthenticatedUser): UserResponse {
    return this.authService.getMe(user);
  }

  @Patch('me')
  async updateMe(
    @CurrentUser() user: AuthenticatedUser,
    @Body() dto: UpdateMeDto,
  ): Promise<UserResponse> {
    return this.authService.updateMe(user, dto);
  }

  @Public()
  @Post('logout')
  @HttpCode(HttpStatus.OK)
  async logout(
    @Body() _body: EmptyBodyDto,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ): Promise<{ loggedOut: true }> {
    const rawCookie = req.cookies?.[SESSION_COOKIE_NAME] as string | undefined;
    return this.authService.logout(rawCookie, res);
  }

  @AllowMustChangePassword()
  @UserRateLimit({ name: 'change-password', limit: 5, windowMs: 15 * 60_000 })
  @Post('change-password')
  @HttpCode(HttpStatus.OK)
  async changePassword(
    @CurrentUser() user: AuthenticatedUser,
    @Body() dto: ChangePasswordDto,
    @Res({ passthrough: true }) res: Response,
  ): Promise<{ changed: true }> {
    return this.authService.changePassword(user, dto, res);
  }

  @Public()
  @Throttle({ default: { limit: 3, ttl: 60 * 60_000 } })
  @Post('forgot-password')
  @HttpCode(HttpStatus.OK)
  async forgotPassword(
    @Body() dto: ForgotPasswordDto,
    @Res({ passthrough: true }) res: Response,
  ): Promise<{ requested: true }> {
    return this.authService.forgotPassword(dto, res);
  }

  @Public()
  @Throttle({ default: { limit: 10, ttl: 60 * 60_000 } })
  @Post('reset-password')
  @HttpCode(HttpStatus.OK)
  async resetPassword(@Body() dto: ResetPasswordDto): Promise<{ reset: true }> {
    return this.authService.resetPassword(dto);
  }
}
