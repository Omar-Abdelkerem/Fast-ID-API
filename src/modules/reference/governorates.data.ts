import { governorate } from '@prisma/client';

export interface GovernorateItem {
  code: governorate;
  name: {
    ar: string;
    en: string;
  };
}

const RAW_GOVERNORATES: GovernorateItem[] = [
  { code: 'CAIRO', name: { ar: 'القاهرة', en: 'Cairo' } },
  { code: 'GIZA', name: { ar: 'الجيزة', en: 'Giza' } },
  { code: 'ALEXANDRIA', name: { ar: 'الإسكندرية', en: 'Alexandria' } },
  { code: 'QALYUBIA', name: { ar: 'القليوبية', en: 'Qalyubia' } },
  { code: 'PORT_SAID', name: { ar: 'بورسعيد', en: 'Port Said' } },
  { code: 'SUEZ', name: { ar: 'السويس', en: 'Suez' } },
  { code: 'DAKAHLIA', name: { ar: 'الدقهلية', en: 'Dakahlia' } },
  { code: 'SHARQIA', name: { ar: 'الشرقية', en: 'Sharqia' } },
  { code: 'GHARBIA', name: { ar: 'الغربية', en: 'Gharbia' } },
  { code: 'MONUFIA', name: { ar: 'المنوفية', en: 'Monufia' } },
  { code: 'BEHEIRA', name: { ar: 'البحيرة', en: 'Beheira' } },
  { code: 'KAFR_EL_SHEIKH', name: { ar: 'كفر الشيخ', en: 'Kafr El Sheikh' } },
  { code: 'DAMIETTA', name: { ar: 'دمياط', en: 'Damietta' } },
  { code: 'ISMAILIA', name: { ar: 'الإسماعيلية', en: 'Ismailia' } },
  { code: 'FAIYUM', name: { ar: 'الفيوم', en: 'Faiyum' } },
  { code: 'BENI_SUEF', name: { ar: 'بني سويف', en: 'Beni Suef' } },
  { code: 'MINYA', name: { ar: 'المنيا', en: 'Minya' } },
  { code: 'ASSIUT', name: { ar: 'أسيوط', en: 'Assiut' } },
  { code: 'SOHAG', name: { ar: 'سوهاج', en: 'Sohag' } },
  { code: 'QENA', name: { ar: 'قنا', en: 'Qena' } },
  { code: 'LUXOR', name: { ar: 'الأقصر', en: 'Luxor' } },
  { code: 'ASWAN', name: { ar: 'أسوان', en: 'Aswan' } },
  { code: 'RED_SEA', name: { ar: 'البحر الأحمر', en: 'Red Sea' } },
  { code: 'NEW_VALLEY', name: { ar: 'الوادي الجديد', en: 'New Valley' } },
  { code: 'MATROUH', name: { ar: 'مطروح', en: 'Matrouh' } },
  { code: 'NORTH_SINAI', name: { ar: 'شمال سيناء', en: 'North Sinai' } },
  { code: 'SOUTH_SINAI', name: { ar: 'جنوب سيناء', en: 'South Sinai' } },
];

/**
 * All 27 Egyptian governorates, ordered alphabetically by English name (Contract §2.1).
 */
export const GOVERNORATES: readonly GovernorateItem[] = [...RAW_GOVERNORATES].sort((a, b) =>
  a.name.en.localeCompare(b.name.en, 'en'),
);

export const GOVERNORATE_BY_CODE: ReadonlyMap<governorate, GovernorateItem> = new Map(
  GOVERNORATES.map((item) => [item.code, item]),
);
