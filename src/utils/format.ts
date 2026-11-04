/**
 * Formatting utilities for CLI output
 */
import type { PropertySchema } from '../types/notion.js';

export function formatOutput(data: unknown): string {
  return JSON.stringify(data, null, 2);
}

export function formatPageTitle(page: unknown): string {
  const p = page as {
    properties?: Record<string, {
      type: string;
      title?: Array<{ plain_text: string }>;
    }>;
  };

  if (!p.properties) return 'Untitled';

  // Find title property
  for (const prop of Object.values(p.properties)) {
    if (prop.type === 'title' && prop.title) {
      return prop.title.map(t => t.plain_text).join('') || 'Untitled';
    }
  }
  return 'Untitled';
}

export function formatDatabaseTitle(db: unknown): string {
  const d = db as {
    title?: Array<{ plain_text: string }>;
  };

  if (!d.title || d.title.length === 0) return 'Untitled Database';
  return d.title.map(t => t.plain_text).join('') || 'Untitled Database';
}

export type PropertySchemaMap = Record<string, PropertySchema>;

const WRITABLE_PROPERTY_TYPES = new Set([
  'title',
  'rich_text',
  'number',
  'checkbox',
  'date',
  'url',
  'email',
  'phone_number',
  'select',
  'status',
  'multi_select',
  'people',
  'relation',
]);

function splitList(value: string): string[] {
  return value.split(',').map(item => item.trim()).filter(Boolean);
}

function parseNumber(value: string, property: string): number {
  if (value.trim() === '') {
    throw new Error(`Property "${property}" expects a finite number, received an empty value.`);
  }
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) {
    throw new Error(`Property "${property}" expects a finite number, received "${value}".`);
  }
  return parsed;
}

function parseCheckbox(value: string, property: string): boolean {
  if (value !== 'true' && value !== 'false') {
    throw new Error(`Property "${property}" expects "true" or "false", received "${value}".`);
  }
  return value === 'true';
}

function buildTypedProperty(type: string, value: string, property: string): unknown {
  if (!WRITABLE_PROPERTY_TYPES.has(type)) {
    throw new Error(
      `Property "${property}" has unsupported or read-only type "${type}". ` +
      'Pass a complete Notion property value as JSON if this is intentional.',
    );
  }

  if (value.length === 0 && !['multi_select', 'people', 'relation'].includes(type)) {
    throw new Error(
      `Property "${property}" cannot be set from an empty value. Use --clear-prop to unset it.`,
    );
  }

  switch (type) {
    case 'title':
      return { title: [{ text: { content: value } }] };
    case 'status':
      return { status: { name: value } };
    case 'select':
      return { select: { name: value } };
    case 'multi_select':
      return { multi_select: splitList(value).map(name => ({ name })) };
    case 'rich_text':
      return { rich_text: [{ text: { content: value } }] };
    case 'number':
      return { number: parseNumber(value, property) };
    case 'checkbox':
      return { checkbox: parseCheckbox(value, property) };
    case 'date':
      return { date: { start: value } };
    case 'url':
      return { url: value };
    case 'email':
      return { email: value };
    case 'phone_number':
      return { phone_number: value };
    case 'people':
      return { people: splitList(value).map(id => ({ id })) };
    case 'relation':
      return { relation: splitList(value).map(id => ({ id })) };
  }
}

function parseRawPropertyJson(property: string, value: string): unknown {
  try {
    return JSON.parse(value);
  } catch (error) {
    throw new Error(`Invalid JSON value for property "${property}": ${(error as Error).message}`);
  }
}

/**
 * Parse `Name[:type]=value` arguments into Notion page properties.
 *
 * Untyped values are resolved from the data-source schema. Explicit type hints
 * intentionally take precedence, which keeps the CLI useful for advanced API
 * callers while avoiding ambiguous value-shape guessing (for example, a comma
 * in rich text must never silently turn it into a multi-select value).
 */
export function parseProperties(
  props: string[],
  schema?: PropertySchemaMap,
): Record<string, unknown> {
  const result: Record<string, unknown> = {};

  for (const prop of props) {
    const eqIndex = prop.indexOf('=');
    if (eqIndex === -1) {
      throw new Error(`Invalid property "${prop}". Expected Name[:type]=value.`);
    }

    let key = prop.slice(0, eqIndex);
    const value = prop.slice(eqIndex + 1);

    // An exact schema name wins even when it contains a colon. Otherwise the
    // final colon introduces an explicit type hint: "Key:type=Value".
    let typeHint: string | undefined;
    const fullKey = key;
    const colonIndex = schema?.[fullKey] ? -1 : key.lastIndexOf(':');
    if (colonIndex !== -1) {
      typeHint = key.slice(colonIndex + 1).trim();
      key = key.slice(0, colonIndex);
      if (!typeHint) {
        throw new Error(`Invalid property "${prop}": type hint cannot be empty.`);
      }
    }

    if (!key) {
      throw new Error(`Invalid property "${prop}": property name cannot be empty.`);
    }

    if (typeHint === 'json') {
      result[key] = parseRawPropertyJson(key, value);
      continue;
    }

    // A complete JSON value is an explicit API-level escape hatch, not type
    // inference. Type hints and schema-backed values retain normal validation.
    if (!typeHint && !schema && (value.startsWith('[') || value.startsWith('{'))) {
      result[key] = parseRawPropertyJson(key, value);
      continue;
    }

    const schemaType = schema?.[key]?.type;
    const propertyType = typeHint ?? schemaType;
    if (!propertyType) {
      const detail = schema
        ? `Property "${key}" does not exist in the data-source schema.`
        : `Cannot determine the type of property "${key}" without a schema.`;
      throw new Error(`${detail} Use ${key}:<type>=<value> to provide an explicit override.`);
    }

    result[key] = buildTypedProperty(propertyType === 'text' ? 'rich_text' : propertyType, value, key);
  }

  return result;
}

// Operators that take boolean true instead of a user-supplied value
const BOOLEAN_OPERATORS = new Set(['is_empty', 'is_not_empty']);

// Date operators that take an empty object {} instead of a date string
const VALUELESS_DATE_OPERATORS = new Set([
  'past_week', 'past_month', 'past_year',
  'next_week', 'next_month', 'next_year',
  'this_week',
]);

/**
 * Resolve the filter value based on operator semantics.
 * - is_empty / is_not_empty → true (boolean)
 * - past_week, next_month, etc. → {} (empty object)
 * - number types → parseFloat
 * - checkbox → boolean
 * - everything else → raw string value
 */
export function isValuelessFilterOperator(filterType: string): boolean {
  return BOOLEAN_OPERATORS.has(filterType) || VALUELESS_DATE_OPERATORS.has(filterType);
}

function resolveFilterValue(filterType: string, value: string | undefined, propType: string): unknown {
  if (BOOLEAN_OPERATORS.has(filterType)) return true;
  if (VALUELESS_DATE_OPERATORS.has(filterType)) {
    if (!['date', 'created_time', 'last_edited_time'].includes(propType)) {
      throw new Error(`Operator "${filterType}" is only valid for date properties.`);
    }
    return {};
  }
  if (value === undefined) {
    throw new Error(`Filter operator "${filterType}" requires a value.`);
  }
  if (propType === 'number' || propType === 'unique_id') return parseNumber(value, 'filter');
  if (propType === 'checkbox') return parseCheckbox(value, 'filter');
  return value;
}

function filterTypeForProperty(propertyType: string): string {
  switch (propertyType) {
    case 'text':
    case 'rich_text':
      return 'rich_text';
    case 'formula':
    case 'rollup':
      throw new Error(
        `Property type "${propertyType}" requires a nested Notion filter. Use --filter with raw JSON.`,
      );
    default:
      return propertyType;
  }
}

const TEXT_FILTER_OPERATORS = new Set([
  'equals', 'does_not_equal', 'contains', 'does_not_contain',
  'starts_with', 'ends_with', 'is_empty', 'is_not_empty',
]);
const NUMBER_FILTER_OPERATORS = new Set([
  'equals', 'does_not_equal', 'greater_than', 'less_than',
  'greater_than_or_equal_to', 'less_than_or_equal_to', 'is_empty', 'is_not_empty',
]);
const DATE_FILTER_OPERATORS = new Set([
  'equals', 'before', 'after', 'on_or_before', 'on_or_after',
  'is_empty', 'is_not_empty', ...VALUELESS_DATE_OPERATORS,
]);
const FILTER_OPERATORS_BY_TYPE: Record<string, ReadonlySet<string>> = {
  title: TEXT_FILTER_OPERATORS,
  rich_text: TEXT_FILTER_OPERATORS,
  url: TEXT_FILTER_OPERATORS,
  email: TEXT_FILTER_OPERATORS,
  phone_number: TEXT_FILTER_OPERATORS,
  number: NUMBER_FILTER_OPERATORS,
  unique_id: NUMBER_FILTER_OPERATORS,
  checkbox: new Set(['equals', 'does_not_equal']),
  select: new Set(['equals', 'does_not_equal', 'is_empty', 'is_not_empty']),
  status: new Set(['equals', 'does_not_equal', 'is_empty', 'is_not_empty']),
  multi_select: new Set(['contains', 'does_not_contain', 'is_empty', 'is_not_empty']),
  date: DATE_FILTER_OPERATORS,
  created_time: DATE_FILTER_OPERATORS,
  last_edited_time: DATE_FILTER_OPERATORS,
  people: new Set(['contains', 'does_not_contain', 'is_empty', 'is_not_empty']),
  created_by: new Set(['contains', 'does_not_contain', 'is_empty', 'is_not_empty']),
  last_edited_by: new Set(['contains', 'does_not_contain', 'is_empty', 'is_not_empty']),
  relation: new Set(['contains', 'does_not_contain', 'is_empty', 'is_not_empty']),
  files: new Set(['is_empty', 'is_not_empty']),
  verification: new Set(['status']),
};

function validateFilterOperator(propertyType: string, operator: string): void {
  const allowed = FILTER_OPERATORS_BY_TYPE[propertyType];
  if (!allowed) {
    throw new Error(
      `Property type "${propertyType}" is not supported by filter shorthand. Use --filter with raw JSON.`,
    );
  }
  if (!allowed.has(operator)) {
    throw new Error(`Filter operator "${operator}" is not valid for property type "${propertyType}".`);
  }
}

export function parseFilter(
  property: string,
  filterType: string,
  value?: string,
  propType?: string,
  schema?: PropertySchemaMap,
): Record<string, unknown> {
  const filter: Record<string, unknown> = { property };

  const schemaType = schema?.[property]?.type;
  const propertyType = propType ?? schemaType;
  if (!propertyType) {
    const detail = schema
      ? `Property "${property}" does not exist in the data-source schema.`
      : `Cannot determine the type of property "${property}" without a schema.`;
    throw new Error(`${detail} Pass --filter-prop-type as an explicit override.`);
  }

  const apiFilterType = filterTypeForProperty(propertyType);
  validateFilterOperator(apiFilterType, filterType);
  filter[apiFilterType] = {
    [filterType]: resolveFilterValue(filterType, value, apiFilterType),
  };
  return filter;
}
