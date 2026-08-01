# Data-source filter reference

`notion db query` inspects the data-source schema and constructs Notion filters
from repeated command-line groups:

```bash
notion db query <database-or-source-id> \
  --filter-prop "Property" \
  --filter-type <operator> \
  --filter-value "value"
```

Property names and option values are case-sensitive. Run
`notion db schema <id>` before filtering an unfamiliar source.

## Combining filters

Repeat `--filter-prop`, `--filter-type`, and values in the same order. The CLI
combines every group with `AND`:

```bash
notion db query <source-id> \
  --filter-prop Status --filter-type does_not_equal --filter-value Done \
  --filter-prop Priority --filter-type equals --filter-value High \
  --filter-prop Assignee --filter-type is_empty
```

Valueless operators do not consume a `--filter-value`. `--filter-prop-type` is
normally unnecessary because the schema provides the type. If supplied, repeat
it for every filter group.

## Text-like properties

Applies to `title`, `rich_text`, `url`, `email`, and `phone_number`:

- `equals`
- `does_not_equal`
- `contains`
- `does_not_contain`
- `starts_with`
- `ends_with`
- `is_empty` (no value)
- `is_not_empty` (no value)

```bash
notion db query <source-id> \
  --filter-prop Name --filter-type contains --filter-value "API"
```

## Select and status

`select` and `status` support `equals`, `does_not_equal`, `is_empty`, and
`is_not_empty`. A status is not a select; schema resolution preserves the actual
type.

```bash
notion db query <source-id> \
  --filter-prop Status --filter-type equals --filter-value "In progress"
```

## Multi-select

`multi_select` supports `contains`, `does_not_contain`, `is_empty`, and
`is_not_empty`.

```bash
notion db query <source-id> \
  --filter-prop Tags --filter-type contains --filter-value backend
```

## Number

`number` supports:

- `equals`, `does_not_equal`
- `greater_than`, `greater_than_or_equal_to`
- `less_than`, `less_than_or_equal_to`
- `is_empty`, `is_not_empty` (no value)

```bash
notion db query <source-id> \
  --filter-prop Estimate --filter-type greater_than --filter-value 5
```

## Date and timestamp

Date-like properties support `equals`, `before`, `after`, `on_or_before`,
`on_or_after`, `is_empty`, and `is_not_empty`. Relative operators take no value:

- `past_week`, `past_month`, `past_year`
- `this_week`
- `next_week`, `next_month`, `next_year`

```bash
notion db query <source-id> \
  --filter-prop Due --filter-type on_or_before --filter-value 2026-08-31

notion db query <source-id> \
  --filter-prop Due --filter-type next_week
```

## Checkbox

`checkbox` supports `equals` and `does_not_equal` with `true` or `false`.

```bash
notion db query <source-id> \
  --filter-prop Complete --filter-type equals --filter-value false
```

## People and relation

These properties support `contains`, `does_not_contain`, `is_empty`, and
`is_not_empty`. Membership values are IDs, not display names.

```bash
notion db query <source-id> \
  --filter-prop Assignee --filter-type contains --filter-value <person-id>
```

File properties support `is_empty` and `is_not_empty` through shorthand.
Rollup arrays use nested `any`, `every`, or `none` filter objects and therefore
belong in a raw filter.

## Formula and rollup details

Formula and rollup filters have nested type-specific shapes that cannot always
be represented safely by the shorthand. Pass a complete official Notion filter
object instead.

## Raw filters

Repeat `--filter` to combine official filter objects with `AND`:

```bash
notion db query <source-id> \
  --filter '{"property":"Status","status":{"equals":"Done"}}' \
  --filter '{"timestamp":"created_time","created_time":{"after":"2026-01-01"}}' \
  --json
```

Use raw filters for nested `and`/`or`, formula, rollup, unique ID, verification,
and other shapes not covered by the shorthand.

## Response size and pagination

Repeat `--filter-properties <property-id-or-name>` to return only needed
properties. Use `--cursor <next_cursor>` to continue a query.

The CLI raises an error if Notion reports the request as incomplete at the
10,000-result limit. Partition large scans into non-overlapping time ranges.
This completes row pagination only. A returned row can still contain truncated
property values; inspect `has_more` and use `notion page property <page-id>
<property-id> --all --json` when the complete value matters.
