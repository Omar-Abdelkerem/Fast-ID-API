import { users } from '@prisma/client';
import { maskNationalId } from '../../common/utils/mask';

/**
 * Citizen summary returned by GET /admin/citizens (§10.4) and PATCH /admin/citizens/:id (§10.5).
 */
export interface AdminCitizenResponse {
  id: string;
  fullName: string;
  nationalIdMasked: string;
  email: string;
  phone: string;
  isActive: boolean;
  createdAt: string;
}

export function mapAdminCitizenResponse(user: users): AdminCitizenResponse {
  return {
    id: user.id,
    fullName: user.full_name,
    nationalIdMasked: user.national_id ? maskNationalId(user.national_id) : '',
    email: user.email,
    phone: user.phone,
    isActive: user.is_active,
    createdAt: user.created_at.toISOString(),
  };
}
