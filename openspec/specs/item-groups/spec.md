# item-groups Specification

## Purpose
Item grouping: named, sorted, color-coded groups that organize products for the POS grid,
menu builder, and reporting rollups.
## Requirements
### Requirement: Group management

`web/item-groups.html` (admin/manager) SHALL manage item groups (name, sort, color swatch,
active) and assign products to groups from a two-pane picker (all products ⇄ in group).
A product may belong to many groups; deleting is deactivation (groups referenced by menus
or store sections must never dangle).

#### Scenario: Build a "Day Tickets" group
- **WHEN** a manager creates group "Day Tickets" and adds Adult/Child/Senior
- **THEN** GET /api/groups shows product_count 3 and the picker reflects membership.

### Requirement: Read API for consumers

`GET /api/groups` (any signed-in role) SHALL return groups with product counts;
`listGroups`, `productIdsInGroup`, `groupsForProduct` exports match the design contract —
they are consumed by menu-builder, webstore-builder, and item-config.

#### Scenario: Consumers see only active
- **WHEN** a group is deactivated
- **THEN** it disappears from `GET /api/groups` default listing (an `?all=1` flag includes
  inactive for the editor) while existing menu/store references degrade gracefully
  (empty section / skipped generation, no errors).

### Requirement: Assignment audit

Group create/edit and product assignment changes SHALL write audit_log entries.

#### Scenario: Traceable regrouping
- **WHEN** products are re-assigned
- **THEN** an audit row records the group id and the new product id list.

