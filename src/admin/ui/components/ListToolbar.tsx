import type { CSSProperties } from "react";
import { Icon } from "./Icon.tsx";
import {
  ALL_FILTER_VALUE,
  EMPTY_LIST_FILTER,
  effectiveFilterValue,
  isListFiltered,
  listSortOptions,
  type ListConfig,
  type ListFilterState,
} from "../views/ConfigView/listFilters.ts";

const controlStyle: CSSProperties = {
  padding: "7px 10px", fontSize: "12.5px", fontFamily: "var(--font-sans)",
  border: "1px solid var(--border)", borderRadius: "var(--radius-sm)",
  background: "var(--panel-2)", color: "var(--text)", outline: "none",
};

interface ListToolbarProps<T> {
  noun: string;
  searchPlaceholder: string;
  config: ListConfig<T>;
  state: ListFilterState;
  onChange: (next: ListFilterState) => void;
  shown: number;
  total: number;
}

export function ListToolbar<T>({ noun, searchPlaceholder, config, state, onChange, shown, total }: ListToolbarProps<T>) {
  const sortOptions = listSortOptions(config);
  const sortValue = sortOptions.some((option) => option.value === state.sort) ? state.sort : EMPTY_LIST_FILTER.sort;
  return (
    <div
      data-config-ignore-dirty
      role="search"
      aria-label={`Filter ${noun}`}
      style={{ display: "flex", flexWrap: "wrap", gap: "8px 10px", alignItems: "center", marginBottom: "14px" }}
    >
      <div style={{ position: "relative", flex: "1 1 240px", minWidth: "200px", maxWidth: "360px" }}>
        <Icon
          name="search" size={14}
          style={{ position: "absolute", left: "10px", top: "50%", transform: "translateY(-50%)", color: "var(--text-ghost)", pointerEvents: "none" }}
        />
        <input
          type="search"
          aria-label={`Search ${noun}`}
          value={state.query}
          placeholder={searchPlaceholder}
          onChange={(event) => onChange({ ...state, query: event.target.value })}
          style={{ ...controlStyle, width: "100%", paddingLeft: "30px" }}
        />
      </div>
      {config.filters.filter((definition) => definition.options.length > 0).map((definition) => (
        <select
          key={definition.id}
          aria-label={definition.label}
          value={effectiveFilterValue(definition, state)}
          onChange={(event) => onChange({ ...state, filters: { ...state.filters, [definition.id]: event.target.value } })}
          style={{ ...controlStyle, cursor: "pointer" }}
        >
          <option value={ALL_FILTER_VALUE}>{definition.allLabel}</option>
          {definition.options.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
        </select>
      ))}
      <select
        aria-label={`Sort ${noun}`}
        value={sortValue}
        onChange={(event) => onChange({ ...state, sort: event.target.value })}
        style={{ ...controlStyle, cursor: "pointer" }}
      >
        {sortOptions.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
      </select>
      {isListFiltered(state) && (
        <button className="btn ghost" onClick={() => onChange(EMPTY_LIST_FILTER)}>
          <Icon name="x" size={13} /> Clear
        </button>
      )}
      <div style={{ flex: 1 }} />
      <span className="mono" aria-live="polite" style={{ fontSize: "11.5px", color: "var(--text-faint)" }}>
        {shown} of {total}
      </span>
    </div>
  );
}

export function NoListMatches({ noun, onClear }: { noun: string; onClear: () => void }) {
  return (
    <div className="placeholder" style={{ minHeight: "120px", flexDirection: "column", gap: "10px" }}>
      <span>No {noun} match the current search or filters.</span>
      <button className="btn" onClick={onClear}>Clear filters</button>
    </div>
  );
}
