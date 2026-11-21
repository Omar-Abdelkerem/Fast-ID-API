import { users } from '@prisma/client';
import { formatDateOnlyUtc } from '../../common/utils/dates';

export interface UserResponse {
  id: string;
  role: users['role'];
  fullName: string;
  email: string;
  phone: string;
  preferredLanguage: users['preferred_language'];
  nationalId: string | null;
  birthDate: string | null;
  gender: users['gender'] | null;
  governorate: users['governorate'] | null;
  isActive: boolean;
  mustChangePassword: boolean;
  createdAt: string;
  updatedAt: string;
}

export function mapUserResponse(user: users): UserResponse {
  return {
    id: user.id,
    role: user.role,
    fullName: user.full_name,
    email: user.email,
    phone: user.phone,
    preferredLanguage: user.preferred_language,
    nationalId: user.national_id ?? null,
    birthDate: user.birth_date ? formatDateOnlyUtc(user.birth_date) : null,
    gender: user.gender ?? null,
    governorate: user.governorate ?? null,
    isActive: user.is_active,
    mustChangePassword: user.must_change_password,
    createdAt: user.created_at.toISOString(),
    updatedAt: user.updated_at.toISOString(),
  };
}
