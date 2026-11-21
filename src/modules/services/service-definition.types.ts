import { service_availability } from '@prisma/client';

export const SERVICE_CATEGORIES = ['IDENTITY', 'LICENSE', 'CIVIL_RECORD', 'OTHER'] as const;
export type ServiceCategory = (typeof SERVICE_CATEGORIES)[number];

export const ALLOWED_DOCUMENT_MIME_TYPES = ['image/jpeg', 'image/png', 'application/pdf'] as const;
export type AllowedDocumentMimeType = (typeof ALLOWED_DOCUMENT_MIME_TYPES)[number];

export const FORM_FIELD_TYPES = [
  'TEXT',
  'TEXTAREA',
  'NUMBER',
  'DATE',
  'SELECT',
  'CHECKBOX',
] as const;
export type FormFieldType = (typeof FORM_FIELD_TYPES)[number];

export interface LocalizedText {
  ar: string;
  en: string;
}

export interface MoneyValue {
  amount: number;
  currency: 'EGP';
}

export interface RequiredDocumentDefinition {
  key: string;
  label: LocalizedText;
  required: boolean;
  allowedMimeTypes: AllowedDocumentMimeType[];
  maxSizeBytes: number;
}

export interface FormFieldOption {
  value: string;
  label: LocalizedText;
}

export interface FormFieldValidation {
  minLength?: number;
  maxLength?: number;
  min?: number;
  max?: number;
  minDate?: string;
  maxDate?: string;
  pattern?: string;
}

export interface FormFieldDefinition {
  key: string;
  label: LocalizedText;
  helpText: LocalizedText | null;
  type: FormFieldType;
  required: boolean;
  options: FormFieldOption[] | null;
  validation: FormFieldValidation;
}

export interface ServiceFormSchema {
  fields: FormFieldDefinition[];
}

export interface ServiceDefinition {
  name: LocalizedText;
  description: LocalizedText;
  category: ServiceCategory;
  fee: MoneyValue;
  slaDays: number;
  validityYears: number | null;
  requiredDocuments: RequiredDocumentDefinition[];
  formSchema: ServiceFormSchema;
}

export interface ServiceSummaryResponse {
  id: string;
  name: LocalizedText;
  description: LocalizedText;
  category: ServiceCategory;
  fee: MoneyValue;
  slaDays: number;
  validityYears: number | null;
  version: number;
}

export interface PublicServiceResponse extends ServiceSummaryResponse {
  requiredDocuments: RequiredDocumentDefinition[];
  formSchema: ServiceFormSchema;
  publishedAt: string;
}

export interface AdminServiceResponse {
  id: string;
  availability: service_availability;
  draft: ServiceDefinition;
  publishedVersion: number | null;
  publishedAt: string | null;
  hasUnpublishedChanges: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface ServiceVersionResponse {
  version: number;
  publishedAt: string;
  definition: ServiceDefinition;
}
