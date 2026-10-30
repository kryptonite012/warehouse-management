# Administrator guide

1. **Sign in** with the seeded admin account. Change its password with the forgot/reset flow if needed.
2. **Sites**: *Warehouses → New site*. Create central warehouses first, then dark stores (GPS and
   service PIN codes / radius are required for customer serviceability). Set each dark store's
   supplying warehouse so replenishment knows where stock comes from.
3. **Layout**: open a site → *Generate zone layout*. Use one zone per temperature
   (AMBIENT / CHILLED / FROZEN). Bins get barcodes (`LOC-<site>-<code>`) and a serpentine pick
   sequence automatically. Click a bin to print its QR label or mark it restricted or blocked.
4. **Catalog**: *Products → Import CSV* (validate first; nothing is written if any row fails) or
   create products one by one. Products can only be slotted into bins with matching storage
   temperature.
5. **People**: *Employees → Add employee*. Assign roles and, for site staff, restrict them to their
   sites. Roles and their permissions are shown on the right and are configurable
   (`PUT /api/v1/roles`).
6. **Settings**: approval limits per role (`procurement.approval_limits`), whether barcode scanning is
   mandatory, store allocation preference, customer data retention.
7. **Oversight**: *Overview* and *Analytics* (live data), *Audit Logs* (every privileged action and
   every denied attempt), *Store Sync* (edge agent health and conflicts).
