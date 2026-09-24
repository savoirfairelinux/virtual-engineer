export interface ListFilterState {
  query: string;
  filters: Readonly<Record<string, string>>;
  sort: string;
}

export const EMPTY_LIST_FILTER: ListFilterState = { query: "", filters: {}, sort: "default" };

export const ALL_FILTER_VALUE = "all";

export interface ListOption {
  value: string;
  label: string;
}

export interface ListFilterDefinition<T> {
  id: string;
  label: string;
  allLabel: string;
  options: readonly ListOption[];
  value: (item: T) => string | readonly string[];
}

export interface ListConfig<T> {
  search: (item: T) => ReadonlyArray<string | null | undefined>;
  name: (item: T) => string;
  filters: ReadonlyArray<ListFilterDefinition<T>>;
  updatedAt?: ((item: T) => string | undefined) | undefined;
  createdAt?: ((item: T) => string | undefined) | undefined;
}

export function matchesSearch(query: string, fields: ReadonlyArray<string | null | undefined>): boolean {
  const terms = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (terms.length === 0) return true;
  const haystack = fields.filter((field): field is string => typeof field === "string").join("\n").toLowerCase();
  return terms.every((term) => haystack.includes(term));
}

/** Returns the selected value, falling back to "all" when the option no longer exists. */
export function effectiveFilterValue<T>(definition: ListFilterDefinition<T>, state: ListFilterState): string {
  const value = state.filters[definition.id];
  return value !== undefined && definition.options.some((option) => option.value === value) ? value : ALL_FILTER_VALUE;
}

export function isListFiltered<T>(state: ListFilterState, config: ListConfig<T>): boolean {
  const hasActiveFilter = config.filters.some((definition) =>
    effectiveFilterValue(definition, state) !== ALL_FILTER_VALUE
  );
  const hasActiveSort = state.sort !== EMPTY_LIST_FILTER.sort
    && listSortOptions(config).some((option) => option.value === state.sort);
  return state.query.trim().length > 0 || hasActiveSort || hasActiveFilter;
}

export function listSortOptions<T>(config: ListConfig<T>): ListOption[] {
  return [
    { value: "default", label: "Default order" },
    { value: "name-asc", label: "Name (A–Z)" },
    { value: "name-desc", label: "Name (Z–A)" },
    ...(config.updatedAt ? [{ value: "updated", label: "Recently updated" }] : []),
    ...(config.createdAt ? [{ value: "created", label: "Recently created" }] : []),
  ];
}

function timestamp(value: string | undefined): number {
  const parsed = value ? Date.parse(value) : Number.NaN;
  return Number.isNaN(parsed) ? Number.NEGATIVE_INFINITY : parsed;
}

function comparator<T>(config: ListConfig<T>, sort: string): ((a: T, b: T) => number) | null {
  const byName = (a: T, b: T) => config.name(a).localeCompare(config.name(b), undefined, { sensitivity: "base", numeric: true });
  const byDate = (read: (item: T) => string | undefined) => (a: T, b: T) => timestamp(read(b)) - timestamp(read(a)) || 0;
  if (sort === "name-asc") return byName;
  if (sort === "name-desc") return (a, b) => byName(b, a);
  if (sort === "updated" && config.updatedAt) return byDate(config.updatedAt);
  if (sort === "created" && config.createdAt) return byDate(config.createdAt);
  return null;
}

export function applyListFilter<T>(items: readonly T[], state: ListFilterState, config: ListConfig<T>): T[] {
  const active = config.filters
    .map((definition) => ({ definition, value: effectiveFilterValue(definition, state) }))
    .filter(({ value }) => value !== ALL_FILTER_VALUE);
  const filtered = items.filter((item) => {
    if (!matchesSearch(state.query, config.search(item))) return false;
    return active.every(({ definition, value }) => {
      const itemValue = definition.value(item);
      return typeof itemValue === "string" ? itemValue === value : itemValue.includes(value);
    });
  });
  const compare = comparator(config, state.sort);
  return compare ? filtered.sort(compare) : filtered;
}
