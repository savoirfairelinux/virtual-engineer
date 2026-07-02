// Synthetic bundle entry for the Virtual Engineer UI design system.
// Components with Vite-only imports (import.meta.glob) are replaced by shims.
// Stat/Drawer/Modal shims also fix transitive Icon imports.

export { Bars } from "../src/admin/ui/components/Bars.tsx";
export { Drawer, DetailSection, DetailRow, StatusBanner } from "./shims/Drawer.tsx";
export { Icon } from "./shims/Icon.tsx";
export { Meta } from "../src/admin/ui/components/Meta.tsx";
export {
  Modal, Field, FieldInput, FieldSelect,
  FieldTextarea, FormError, FormRow, FormActions,
} from "./shims/Modal.tsx";
export { ProviderGlyph } from "./shims/ProviderGlyph.tsx";
export { RowCard } from "../src/admin/ui/components/RowCard.tsx";
export { Stat } from "./shims/Stat.tsx";
export { StatePill } from "../src/admin/ui/components/StatePill.tsx";
export { Tabs, TabPanel } from "../src/admin/ui/components/Tabs.tsx";
export { Tag } from "../src/admin/ui/components/Tag.tsx";
export { Toggle } from "../src/admin/ui/components/Toggle.tsx";
