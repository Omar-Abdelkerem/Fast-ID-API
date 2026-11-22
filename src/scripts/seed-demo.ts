import 'dotenv/config';
import { Logger } from '@nestjs/common';
import { Prisma, PrismaClient } from '@prisma/client';
import * as argon2 from 'argon2';
import { parseDateOnlyUtc } from '../common/utils/dates';
import { parseNationalId } from '../common/utils/national-id';
import { validatePasswordStrength } from '../common/utils/password';
import { validateCreateServicePayload } from '../modules/services/service-definition.validator';

export interface DemoSeedSummary {
  servicesCreated: string[];
  servicesExisting: string[];
  usersCreated: string[];
  usersExisting: string[];
}

export const DEMO_ACCOUNTS = {
  adminEmail: 'demo.admin@example.com',
  cairoAgentEmail: 'demo.agent.cairo@example.com',
  alexAgentEmail: 'demo.agent.alex@example.com',
  citizenEmail: 'demo.citizen@example.com',
  citizenNationalId: '29805150112319',
} as const;

const RAW_DEMO_SERVICES: readonly Record<string, unknown>[] = [
  {
    id: 'national-id',
    name: {
      ar: 'تجديد بطاقة الرقم القومي',
      en: 'National ID Renewal',
    },
    description: {
      ar: 'خدمة تجديد بطاقة الرقم القومي للمواطنين المصريين مع التوصيل إلى المنزل.',
      en: 'Renew your Egyptian National ID card online with verified home delivery.',
    },
    category: 'IDENTITY',
    fee: { amount: 15000, currency: 'EGP' },
    slaDays: 7,
    validityYears: 7,
    requiredDocuments: [
      {
        key: 'personalPhoto',
        label: { ar: 'صورة شخصية حديثة', en: 'Recent Personal Photo' },
        required: true,
        allowedMimeTypes: ['image/jpeg', 'image/png'],
        maxSizeBytes: 2 * 1024 * 1024,
      },
      {
        key: 'oldIdCopy',
        label: { ar: 'صورة البطاقة السابقة', en: 'Copy of Previous National ID' },
        required: true,
        allowedMimeTypes: ['image/jpeg', 'image/png', 'application/pdf'],
        maxSizeBytes: 5 * 1024 * 1024,
      },
    ],
    formSchema: {
      fields: [
        {
          key: 'maritalStatus',
          label: { ar: 'الحالة الاجتماعية', en: 'Marital Status' },
          helpText: null,
          type: 'SELECT',
          required: true,
          options: [
            { value: 'SINGLE', label: { ar: 'أعزب / عزباء', en: 'Single' } },
            { value: 'MARRIED', label: { ar: 'متزوج / متزوجة', en: 'Married' } },
            { value: 'DIVORCED', label: { ar: 'مطلق / مطلقة', en: 'Divorced' } },
            { value: 'WIDOWED', label: { ar: 'أرمل / أرملة', en: 'Widowed' } },
          ],
          validation: {},
        },
        {
          key: 'occupation',
          label: { ar: 'المهنة', en: 'Occupation' },
          helpText: {
            ar: 'كما تظهر في بطاقة الرقم القومي',
            en: 'As displayed on your National ID card',
          },
          type: 'TEXT',
          required: true,
          options: null,
          validation: { minLength: 2, maxLength: 80 },
        },
        {
          key: 'confirmAccuracy',
          label: {
            ar: 'أقر بصحة جميع البيانات المقدمة',
            en: 'I confirm all submitted information is accurate',
          },
          helpText: null,
          type: 'CHECKBOX',
          required: true,
          options: null,
          validation: {},
        },
      ],
    },
  },
  {
    id: 'driving-license',
    name: {
      ar: 'تجديد رخصة قيادة خاصة',
      en: 'Private Driving License Renewal',
    },
    description: {
      ar: 'تجديد رخصة القيادة الخاصة لمدة عشر سنوات مع التحقق الطبي والتوصيل السريع.',
      en: 'Renew your private driving license for ten years with medical verification and delivery.',
    },
    category: 'LICENSE',
    fee: { amount: 35000, currency: 'EGP' },
    slaDays: 5,
    validityYears: 10,
    requiredDocuments: [
      {
        key: 'medicalCertificate',
        label: { ar: 'شهادة الكشف الطبي', en: 'Medical Fitness Certificate' },
        required: true,
        allowedMimeTypes: ['application/pdf', 'image/jpeg', 'image/png'],
        maxSizeBytes: 5 * 1024 * 1024,
      },
      {
        key: 'personalPhoto',
        label: { ar: 'صورة شخصية حديثة', en: 'Recent Personal Photo' },
        required: true,
        allowedMimeTypes: ['image/jpeg', 'image/png'],
        maxSizeBytes: 2 * 1024 * 1024,
      },
    ],
    formSchema: {
      fields: [
        {
          key: 'bloodType',
          label: { ar: 'فصيلة الدم', en: 'Blood Type' },
          helpText: null,
          type: 'SELECT',
          required: true,
          options: [
            { value: 'A_POS', label: { ar: 'A+', en: 'A+' } },
            { value: 'A_NEG', label: { ar: 'A-', en: 'A-' } },
            { value: 'B_POS', label: { ar: 'B+', en: 'B+' } },
            { value: 'B_NEG', label: { ar: 'B-', en: 'B-' } },
            { value: 'O_POS', label: { ar: 'O+', en: 'O+' } },
            { value: 'O_NEG', label: { ar: 'O-', en: 'O-' } },
            { value: 'AB_POS', label: { ar: 'AB+', en: 'AB+' } },
            { value: 'AB_NEG', label: { ar: 'AB-', en: 'AB-' } },
          ],
          validation: {},
        },
        {
          key: 'previousLicenseNumber',
          label: { ar: 'رقم الرخصة السابقة', en: 'Previous License Number' },
          helpText: null,
          type: 'TEXT',
          required: true,
          options: null,
          validation: { minLength: 5, maxLength: 20, pattern: '^[A-Za-z0-9-]+$' },
        },
        {
          key: 'requiresGlasses',
          label: {
            ar: 'يرتدي نظارة طبية أثناء القيادة',
            en: 'Wears corrective lenses while driving',
          },
          helpText: null,
          type: 'CHECKBOX',
          required: false,
          options: null,
          validation: {},
        },
      ],
    },
  },
  {
    id: 'birth-certificate',
    name: {
      ar: 'شهادة ميلاد مميكنة',
      en: 'Computerized Birth Certificate',
    },
    description: {
      ar: 'استخراج شهادة ميلاد مميكنة معتمدة بدون رسوم إلكترونية وتوصيل مباشر.',
      en: 'Request an official computerized birth certificate free of charge with direct delivery.',
    },
    category: 'CIVIL_RECORD',
    fee: { amount: 0, currency: 'EGP' },
    slaDays: 3,
    validityYears: null,
    requiredDocuments: [
      {
        key: 'nationalIdCopy',
        label: { ar: 'صورة بطاقة الرقم القومي', en: 'National ID Copy' },
        required: true,
        allowedMimeTypes: ['image/jpeg', 'image/png', 'application/pdf'],
        maxSizeBytes: 5 * 1024 * 1024,
      },
    ],
    formSchema: {
      fields: [
        {
          key: 'motherFullName',
          label: { ar: 'اسم الأم بالكامل', en: 'Mother Full Name' },
          helpText: null,
          type: 'TEXT',
          required: true,
          options: null,
          validation: { minLength: 3, maxLength: 100 },
        },
        {
          key: 'copiesCount',
          label: { ar: 'عدد النسخ المطلوبة', en: 'Number of Copies' },
          helpText: null,
          type: 'NUMBER',
          required: true,
          options: null,
          validation: { min: 1, max: 5 },
        },
      ],
    },
  },
];

/**
 * Idempotently seeds demo services, settings, and local demo users for M8 integration & demos.
 * Strictly refuses to run in production.
 */
export async function seedDemoData(
  prisma: PrismaClient,
  demoPassword: string,
): Promise<DemoSeedSummary> {
  if (process.env.NODE_ENV === 'production') {
    throw new Error('Refusing to run demo seed in production (NODE_ENV=production).');
  }

  const passwordCheck = validatePasswordStrength(demoPassword);
  if (!passwordCheck.valid) {
    throw new Error(
      `DEMO_SEED_PASSWORD does not meet password strength rules: ${passwordCheck.message ?? 'invalid'}`,
    );
  }

  const passwordHash = await argon2.hash(demoPassword, { type: argon2.argon2id });
  const summary: DemoSeedSummary = {
    servicesCreated: [],
    servicesExisting: [],
    usersCreated: [],
    usersExisting: [],
  };

  // 1. Settings singleton
  await prisma.settings.upsert({
    where: { id: 'singleton' },
    update: {},
    create: {
      id: 'singleton',
      support_email: 'support@example.com',
      support_phone: '01000000000',
      announcement: {
        ar: 'مرحباً بكم في منصة Fast ID للخدمات الحكومية الرقمية.',
        en: 'Welcome to Fast ID digital government services.',
      } as unknown as Prisma.InputJsonValue,
    },
  });

  // 2. Demo staff & citizen users
  const citizenParsed = parseNationalId(DEMO_ACCOUNTS.citizenNationalId);
  if (!citizenParsed.valid || !citizenParsed.birthDate || !citizenParsed.gender) {
    throw new Error('Invalid demo citizen national ID configuration.');
  }
  const citizenBirthDate = parseDateOnlyUtc(citizenParsed.birthDate);
  if (!citizenBirthDate) {
    throw new Error('Invalid demo citizen birth date.');
  }

  const demoUsers: Array<{
    email: string;
    createData: Prisma.usersCreateInput;
  }> = [
    {
      email: DEMO_ACCOUNTS.adminEmail,
      createData: {
        role: 'ADMIN',
        full_name: 'Omar Admin',
        email: DEMO_ACCOUNTS.adminEmail,
        phone: '01010000001',
        password_hash: passwordHash,
        preferred_language: 'en',
        is_active: true,
        must_change_password: false,
      },
    },
    {
      email: DEMO_ACCOUNTS.cairoAgentEmail,
      createData: {
        role: 'AGENT',
        full_name: 'Youssef Cairo Agent',
        email: DEMO_ACCOUNTS.cairoAgentEmail,
        phone: '01010000002',
        password_hash: passwordHash,
        governorate: 'CAIRO',
        preferred_language: 'ar',
        is_active: true,
        must_change_password: false,
      },
    },
    {
      email: DEMO_ACCOUNTS.alexAgentEmail,
      createData: {
        role: 'AGENT',
        full_name: 'Mostafa Alexandria Agent',
        email: DEMO_ACCOUNTS.alexAgentEmail,
        phone: '01010000003',
        password_hash: passwordHash,
        governorate: 'ALEXANDRIA',
        preferred_language: 'ar',
        is_active: true,
        must_change_password: false,
      },
    },
    {
      email: DEMO_ACCOUNTS.citizenEmail,
      createData: {
        role: 'CITIZEN',
        full_name: 'Salma Ahmed Hassan',
        email: DEMO_ACCOUNTS.citizenEmail,
        phone: '01010000004',
        password_hash: passwordHash,
        national_id: DEMO_ACCOUNTS.citizenNationalId,
        birth_date: citizenBirthDate,
        gender: citizenParsed.gender,
        preferred_language: 'ar',
        is_active: true,
        must_change_password: false,
      },
    },
  ];

  for (const userSpec of demoUsers) {
    const existing = await prisma.users.findUnique({
      where: { email: userSpec.email },
      select: { id: true },
    });
    if (existing) {
      summary.usersExisting.push(userSpec.email);
      continue;
    }
    await prisma.users.create({ data: userSpec.createData });
    summary.usersCreated.push(userSpec.email);
  }

  // 3. Demo published services (v1) validated via the contract validator
  for (const rawService of RAW_DEMO_SERVICES) {
    const validated = validateCreateServicePayload(rawService);
    const existing = await prisma.services.findUnique({
      where: { id: validated.id },
      select: { id: true },
    });
    if (existing) {
      summary.servicesExisting.push(validated.id);
      continue;
    }

    const now = new Date();
    const defJson = validated.definition as unknown as Prisma.InputJsonValue;
    await prisma.$transaction(async (tx) => {
      await tx.services.create({
        data: {
          id: validated.id,
          availability: 'PUBLISHED',
          draft: defJson,
          published_version: 1,
          published_at: now,
        },
      });
      await tx.service_versions.create({
        data: {
          service_id: validated.id,
          version: 1,
          definition: defJson,
          published_at: now,
        },
      });
    });

    summary.servicesCreated.push(validated.id);
  }

  return summary;
}

async function runCli(): Promise<void> {
  const logger = new Logger('SeedDemo');
  const demoPassword = process.env.DEMO_SEED_PASSWORD;
  if (!demoPassword) {
    logger.error(
      'DEMO_SEED_PASSWORD environment variable is required to run seed:demo (min 8 chars, letter + digit).',
    );
    process.exitCode = 1;
    return;
  }

  const prisma = new PrismaClient();
  try {
    await prisma.$connect();
    const result = await seedDemoData(prisma, demoPassword);
    logger.log(
      `Demo seed complete: services created=[${result.servicesCreated.join(', ')}] existing=[${result.servicesExisting.join(', ')}]; users created=[${result.usersCreated.join(', ')}] existing=[${result.usersExisting.join(', ')}]`,
    );
  } finally {
    await prisma.$disconnect();
  }
}

if (require.main === module) {
  void runCli();
}
