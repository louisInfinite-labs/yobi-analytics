import { ORGANIZATION_LABELS, type OrganizationKey } from "../../types/domain"

interface OrganizationFilterProps {
  value: OrganizationKey | null
  onChange: (value: OrganizationKey | null) => void
}

export function OrganizationFilter({ value, onChange }: OrganizationFilterProps) {
  const options: (OrganizationKey | null)[] = [null, "hololive", "vspo"]

  return (
    <div className="filter-row">
      <span className="filter-row__label">Organization</span>
      <div className="filter-chip-group">
        {options.map((org) => (
          <button
            key={org ?? "all"}
            type="button"
            className="filter-chip"
            aria-pressed={value === org}
            onClick={() => onChange(org)}
          >
            {org ? ORGANIZATION_LABELS[org] : "All"}
          </button>
        ))}
      </div>
    </div>
  )
}
