/**
 * Permission catalogue. Roles are configurable per organization; these codes are
 * the stable vocabulary that guards check against.
 */
export const PERMISSIONS = {
  // identity
  USERS_READ: 'users.read',
  USERS_MANAGE: 'users.manage',
  ROLES_MANAGE: 'roles.manage',
  // organization / sites
  ORG_MANAGE: 'organization.manage',
  WAREHOUSES_READ: 'warehouses.read',
  WAREHOUSES_MANAGE: 'warehouses.manage',
  LAYOUT_MANAGE: 'layout.manage',
  DARK_STORES_READ: 'dark_stores.read',
  DARK_STORES_MANAGE: 'dark_stores.manage',
  // catalog
  PRODUCTS_READ: 'products.read',
  PRODUCTS_MANAGE: 'products.manage',
  PRICES_MANAGE: 'prices.manage',
  // inventory
  INVENTORY_READ: 'inventory.read',
  INVENTORY_RESERVE: 'inventory.reserve',
  INVENTORY_ADJUST_REQUEST: 'inventory.adjust.request',
  INVENTORY_ADJUST_APPROVE: 'inventory.adjust.approve',
  INVENTORY_WRITE_OFF: 'inventory.write_off',
  INVENTORY_COUNT: 'inventory.count',
  INVENTORY_COUNT_RECONCILE: 'inventory.count.reconcile',
  INVENTORY_TRANSFER: 'inventory.transfer',
  INVENTORY_QUALITY: 'inventory.quality',
  // procurement
  SUPPLIERS_READ: 'suppliers.read',
  SUPPLIERS_MANAGE: 'suppliers.manage',
  PO_CREATE: 'purchase_orders.create',
  PO_APPROVE: 'purchase_orders.approve',
  PO_READ: 'purchase_orders.read',
  RECEIVING: 'receiving.perform',
  QC_INSPECT: 'quality.inspect',
  // orders & fulfilment
  ORDERS_READ: 'orders.read',
  ORDERS_MANAGE: 'orders.manage',
  PICKING: 'fulfillment.pick',
  PACKING: 'fulfillment.pack',
  DISPATCH: 'fulfillment.dispatch',
  DELIVERY_MANAGE: 'delivery.manage',
  DELIVERY_PERFORM: 'delivery.perform',
  // finance
  PAYMENTS_READ: 'payments.read',
  REFUNDS_MANAGE: 'refunds.manage',
  // insight & governance
  REPORTS_READ: 'reports.read',
  AI_READ: 'ai.read',
  AUDIT_READ: 'audit.read',
  SETTINGS_MANAGE: 'settings.manage',
  SYNC_MANAGE: 'sync.manage',
  CUSTOMERS_READ: 'customers.read',
} as const;

export type PermissionCode = (typeof PERMISSIONS)[keyof typeof PERMISSIONS];
export const ALL_PERMISSIONS = Object.values(PERMISSIONS) as PermissionCode[];

const P = PERMISSIONS;
const READ_ALL: PermissionCode[] = ALL_PERMISSIONS.filter((p) => p.endsWith('.read'));

/** Default role templates seeded for each organization. Editable afterwards. */
export const DEFAULT_ROLES: Record<string, { name: string; permissions: PermissionCode[] }> = {
  ORG_ADMIN: { name: 'Organization Admin', permissions: ALL_PERMISSIONS },
  REGIONAL_MANAGER: {
    name: 'Regional Manager',
    permissions: [...READ_ALL, P.INVENTORY_ADJUST_APPROVE, P.INVENTORY_TRANSFER, P.DARK_STORES_MANAGE, P.PO_APPROVE, P.ORDERS_MANAGE],
  },
  WAREHOUSE_MANAGER: {
    name: 'Warehouse Manager',
    permissions: [
      P.WAREHOUSES_READ, P.LAYOUT_MANAGE, P.DARK_STORES_READ, P.PRODUCTS_READ, P.INVENTORY_READ,
      P.INVENTORY_ADJUST_REQUEST, P.INVENTORY_ADJUST_APPROVE, P.INVENTORY_COUNT, P.INVENTORY_COUNT_RECONCILE,
      P.INVENTORY_TRANSFER, P.INVENTORY_QUALITY, P.RECEIVING, P.QC_INSPECT, P.PO_READ, P.SUPPLIERS_READ,
      P.ORDERS_READ, P.PICKING, P.PACKING, P.DISPATCH, P.REPORTS_READ, P.USERS_READ, P.SYNC_MANAGE,
    ],
  },
  DARK_STORE_MANAGER: {
    name: 'Dark Store Manager',
    permissions: [
      P.WAREHOUSES_READ, P.DARK_STORES_READ, P.PRODUCTS_READ, P.INVENTORY_READ, P.INVENTORY_ADJUST_REQUEST,
      P.INVENTORY_ADJUST_APPROVE, P.INVENTORY_COUNT, P.INVENTORY_COUNT_RECONCILE, P.INVENTORY_TRANSFER,
      P.INVENTORY_QUALITY, P.RECEIVING, P.ORDERS_READ, P.ORDERS_MANAGE, P.PICKING, P.PACKING, P.DISPATCH,
      P.DELIVERY_MANAGE, P.REPORTS_READ, P.USERS_READ, P.SYNC_MANAGE,
    ],
  },
  INVENTORY_MANAGER: {
    name: 'Inventory Manager',
    permissions: [
      P.WAREHOUSES_READ, P.PRODUCTS_READ, P.INVENTORY_READ, P.INVENTORY_ADJUST_REQUEST, P.INVENTORY_ADJUST_APPROVE,
      P.INVENTORY_WRITE_OFF, P.INVENTORY_COUNT, P.INVENTORY_COUNT_RECONCILE, P.INVENTORY_TRANSFER, P.INVENTORY_QUALITY,
      P.REPORTS_READ, P.AI_READ,
    ],
  },
  PROCUREMENT_MANAGER: {
    name: 'Procurement Manager',
    permissions: [P.PRODUCTS_READ, P.SUPPLIERS_READ, P.SUPPLIERS_MANAGE, P.PO_READ, P.PO_CREATE, P.PO_APPROVE, P.INVENTORY_READ, P.REPORTS_READ, P.AI_READ, P.WAREHOUSES_READ],
  },
  FINANCE_MANAGER: {
    name: 'Finance Manager',
    permissions: [P.PAYMENTS_READ, P.REFUNDS_MANAGE, P.REPORTS_READ, P.ORDERS_READ, P.PO_READ, P.SUPPLIERS_READ, P.PRICES_MANAGE, P.PRODUCTS_READ],
  },
  PICKER: { name: 'Picker', permissions: [P.PICKING, P.INVENTORY_READ, P.PRODUCTS_READ] },
  PACKER: { name: 'Packer', permissions: [P.PACKING, P.ORDERS_READ, P.PRODUCTS_READ] },
  DISPATCH_MANAGER: {
    name: 'Dispatch Manager',
    permissions: [P.DISPATCH, P.DELIVERY_MANAGE, P.ORDERS_READ, P.DARK_STORES_READ],
  },
  DELIVERY_PARTNER: { name: 'Delivery Partner', permissions: [P.DELIVERY_PERFORM] },
  CUSTOMER_SUPPORT: { name: 'Customer Support', permissions: [P.ORDERS_READ, P.ORDERS_MANAGE, P.CUSTOMERS_READ, P.PAYMENTS_READ, P.PRODUCTS_READ] },
  AUDITOR: { name: 'Auditor', permissions: [...READ_ALL] },
};
