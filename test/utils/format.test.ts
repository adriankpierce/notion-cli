import { describe, it, expect } from 'vitest';
import {
  formatOutput,
  formatPageTitle,
  formatDatabaseTitle,
  parseProperties,
  parseFilter,
} from '../../src/utils/format';

describe('Format Utilities', () => {
  describe('formatOutput()', () => {
    it('should format JSON with indentation', () => {
      const data = { name: 'Test', value: 123 };
      const result = formatOutput(data);
      expect(result).toBe('{\n  "name": "Test",\n  "value": 123\n}');
    });

    it('should handle null', () => {
      const result = formatOutput(null);
      expect(result).toBe('null');
    });

    it('should handle arrays', () => {
      const data = [1, 2, 3];
      const result = formatOutput(data);
      expect(result).toBe('[\n  1,\n  2,\n  3\n]');
    });

    it('should handle nested structures', () => {
      const data = { users: [{ name: 'Alice' }, { name: 'Bob' }] };
      const result = formatOutput(data);
      expect(result).toContain('"users"');
      expect(result).toContain('"name": "Alice"');
      expect(result).toContain('"name": "Bob"');
    });
  });

  describe('formatPageTitle()', () => {
    it('should extract title from properties', () => {
      const page = {
        properties: {
          Name: {
            type: 'title',
            title: [{ plain_text: 'My Page Title' }],
          },
        },
      };
      expect(formatPageTitle(page)).toBe('My Page Title');
    });

    it('should return Untitled for missing title', () => {
      const page = {
        properties: {
          Status: {
            type: 'status',
          },
        },
      };
      expect(formatPageTitle(page)).toBe('Untitled');
    });

    it('should return Untitled for empty title array', () => {
      const page = {
        properties: {
          Name: {
            type: 'title',
            title: [],
          },
        },
      };
      expect(formatPageTitle(page)).toBe('Untitled');
    });

    it('should concatenate multi-segment titles', () => {
      const page = {
        properties: {
          Name: {
            type: 'title',
            title: [
              { plain_text: 'Part One ' },
              { plain_text: 'Part Two' },
            ],
          },
        },
      };
      expect(formatPageTitle(page)).toBe('Part One Part Two');
    });

    it('should handle missing properties object', () => {
      const page = {};
      expect(formatPageTitle(page)).toBe('Untitled');
    });

    it('should throw on null/undefined (known gap)', () => {
      // Known gap: formatPageTitle doesn't handle null/undefined gracefully
      // The function expects an object with properties, not null/undefined
      expect(() => formatPageTitle(null)).toThrow();
      expect(() => formatPageTitle(undefined)).toThrow();
    });
  });

  describe('formatDatabaseTitle()', () => {
    it('should extract title from title array', () => {
      const db = {
        title: [{ plain_text: 'My Database' }],
      };
      expect(formatDatabaseTitle(db)).toBe('My Database');
    });

    it('should return Untitled Database for missing title', () => {
      const db = {};
      expect(formatDatabaseTitle(db)).toBe('Untitled Database');
    });

    it('should return Untitled Database for empty title array', () => {
      const db = {
        title: [],
      };
      expect(formatDatabaseTitle(db)).toBe('Untitled Database');
    });

    it('should concatenate multi-segment titles', () => {
      const db = {
        title: [
          { plain_text: 'Project ' },
          { plain_text: 'Tasks' },
        ],
      };
      expect(formatDatabaseTitle(db)).toBe('Project Tasks');
    });
  });

  describe('parseProperties()', () => {
    const schema = {
      Name: { type: 'title' },
      Status: { type: 'status' },
      Notes: { type: 'rich_text' },
      Count: { type: 'number' },
      Done: { type: 'checkbox' },
      Due: { type: 'date' },
      Tags: { type: 'multi_select' },
      Owner: { type: 'people' },
    };

    it('uses schema types rather than guessing from value shapes', () => {
      expect(parseProperties([
        'Name=123',
        'Status=Done',
        'Notes=Hello, World!',
        'Count=42',
        'Done=false',
        'Due=2026-08-01',
        'Tags=bug, urgent',
        'Owner=user-1,user-2',
      ], schema)).toEqual({
        Name: { title: [{ text: { content: '123' } }] },
        Status: { status: { name: 'Done' } },
        Notes: { rich_text: [{ text: { content: 'Hello, World!' } }] },
        Count: { number: 42 },
        Done: { checkbox: false },
        Due: { date: { start: '2026-08-01' } },
        Tags: { multi_select: [{ name: 'bug' }, { name: 'urgent' }] },
        Owner: { people: [{ id: 'user-1' }, { id: 'user-2' }] },
      });
    });

    it('lets an explicit type hint override the schema', () => {
      expect(parseProperties(['Status:select=Done'], schema)).toEqual({
        Status: { select: { name: 'Done' } },
      });
    });

    it('requires a schema or explicit type instead of guessing', () => {
      expect(() => parseProperties(['Status=Done'])).toThrow('without a schema');
      expect(() => parseProperties(['Notes=hello, world'])).toThrow('without a schema');
    });

    it('allows an explicit raw JSON property value without a schema', () => {
      expect(parseProperties(['Status={"status":{"name":"Done"}}'])).toEqual({
        Status: { status: { name: 'Done' } },
      });
    });

    it('allows an explicit :json escape hatch even when a schema is present', () => {
      expect(parseProperties(['Due:json={"date":{"start":"2026-08-01","end":"2026-08-02"}}'], schema))
        .toEqual({ Due: { date: { start: '2026-08-01', end: '2026-08-02' } } });
    });

    it('preserves schema property names that contain a colon', () => {
      const colonSchema = { 'CRM: Status': { type: 'status' } };
      expect(parseProperties(['CRM: Status=Qualified'], colonSchema)).toEqual({
        'CRM: Status': { status: { name: 'Qualified' } },
      });
    });

    it('rejects malformed input, invalid scalar values, and read-only fields', () => {
      expect(() => parseProperties(['Missing'], schema)).toThrow('Expected Name[:type]=value');
      expect(() => parseProperties(['Unknown=value'], schema)).toThrow('does not exist');
      expect(() => parseProperties(['Count=NaN'], schema)).toThrow('finite number');
      expect(() => parseProperties(['Count='], schema)).toThrow('--clear-prop');
      expect(() => parseProperties(['Status='], schema)).toThrow('--clear-prop');
      expect(() => parseProperties(['Done=yes'], schema)).toThrow('true');
      expect(() => parseProperties(['Total=formula'], { Total: { type: 'formula' } })).toThrow('read-only');
    });
  });

  describe('parseFilter()', () => {
    const schema = {
      Name: { type: 'title' },
      Status: { type: 'status' },
      Priority: { type: 'select' },
      Notes: { type: 'rich_text' },
      Count: { type: 'number' },
      Done: { type: 'checkbox' },
      Due: { type: 'date' },
      Website: { type: 'url' },
      Email: { type: 'email' },
      Phone: { type: 'phone_number' },
      Created: { type: 'created_time' },
      Editor: { type: 'last_edited_by' },
      ID: { type: 'unique_id' },
    };

    it('uses status rather than select for a schema-backed status', () => {
      expect(parseFilter('Status', 'equals', 'Done', undefined, schema)).toEqual({
        property: 'Status',
        status: { equals: 'Done' },
      });
    });

    it('maps title and URL properties to their correct filter families', () => {
      expect(parseFilter('Name', 'contains', 'Roadmap', undefined, schema)).toEqual({
        property: 'Name',
        title: { contains: 'Roadmap' },
      });
      expect(parseFilter('Website', 'contains', 'example.com', undefined, schema)).toEqual({
        property: 'Website',
        url: { contains: 'example.com' },
      });
    });

    it('uses the current API filter family for specialized property types', () => {
      expect(parseFilter('Email', 'ends_with', '@example.com', undefined, schema)).toEqual({
        property: 'Email',
        email: { ends_with: '@example.com' },
      });
      expect(parseFilter('Phone', 'starts_with', '+1', undefined, schema)).toEqual({
        property: 'Phone',
        phone_number: { starts_with: '+1' },
      });
      expect(parseFilter('Created', 'after', '2026-01-01', undefined, schema)).toEqual({
        property: 'Created',
        created_time: { after: '2026-01-01' },
      });
      expect(parseFilter('Editor', 'contains', 'user-id', undefined, schema)).toEqual({
        property: 'Editor',
        last_edited_by: { contains: 'user-id' },
      });
      expect(parseFilter('ID', 'greater_than', '41', undefined, schema)).toEqual({
        property: 'ID',
        unique_id: { greater_than: 41 },
      });
    });

    it('parses number and checkbox values strictly', () => {
      expect(parseFilter('Count', 'greater_than', '10', undefined, schema).number)
        .toEqual({ greater_than: 10 });
      expect(parseFilter('Done', 'equals', 'true', undefined, schema).checkbox)
        .toEqual({ equals: true });
      expect(() => parseFilter('Done', 'equals', 'yes', undefined, schema)).toThrow('true');
    });

    it('supports valueless empty and relative-date operators', () => {
      expect(parseFilter('Priority', 'is_empty', undefined, undefined, schema)).toEqual({
        property: 'Priority',
        select: { is_empty: true },
      });
      expect(parseFilter('Due', 'past_week', undefined, undefined, schema)).toEqual({
        property: 'Due',
        date: { past_week: {} },
      });
    });

    it('requires values for normal operators and rejects relative dates on non-dates', () => {
      expect(() => parseFilter('Status', 'equals', undefined, undefined, schema)).toThrow('requires a value');
      expect(() => parseFilter('Status', 'past_week', undefined, undefined, schema)).toThrow('not valid');
      expect(() => parseFilter('Due', 'contains', 'today', undefined, schema)).toThrow('not valid');
    });

    it('requires schema information unless an explicit type override is supplied', () => {
      expect(() => parseFilter('Status', 'equals', 'Done')).toThrow('without a schema');
      expect(parseFilter('Status', 'equals', 'Done', 'select')).toEqual({
        property: 'Status',
        select: { equals: 'Done' },
      });
    });

    it('fails clearly for properties absent from the schema', () => {
      expect(() => parseFilter('Missing', 'equals', 'x', undefined, schema)).toThrow('does not exist');
    });

    it('requires raw JSON for nested formula and rollup filters', () => {
      expect(() => parseFilter('Score', 'equals', '1', undefined, {
        Score: { type: 'formula' },
      })).toThrow('nested Notion filter');
    });
  });
});
