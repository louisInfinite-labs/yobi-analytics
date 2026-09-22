import { ORGANIZATION_LABELS, type OrganizationKey } from "../../../entities/creator/model/domain"
import { NullableSegmented } from "../../../shared/ui/NullableSegmented"

const OPTIONS: OrganizationKey[] = ["hololive", "vspo"]

interface OrganizationFilterProps {
  value: OrganizationKey | null
  onChange: (value: OrganizationKey | null) => void
}

/** Top-level Hololive / VSPO / All single-select filter. */
export function OrganizationFilter({ value, onChange }: OrganizationFilterProps) {
  return (
    <NullableSegmented
      label="Organization"
      value={value}
      onChange={onChange}
      options={OPTIONS.map((org) => ({ label: ORGANIZATION_LABELS[org], value: org }))}
    />
  )
}
