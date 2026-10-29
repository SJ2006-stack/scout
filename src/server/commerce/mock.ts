import {
  cartTotal,
  lineTotal,
  outcomeLabel,
  providerLabel,
  type CartLine,
  type CartSnapshot,
  type CommerceProvider,
  type QuoteSnapshot,
} from "../../shared/commerce.ts";

export type CatalogProduct = {
  id: string;
  name: string;
  unitPrice: number | null;
};

export type ProviderOrder = {
  id: string;
  status: "accepted";
  provenance: "demo";
};

export interface CommerceAdapter {
  readonly provider: CommerceProvider;
  readonly provenance: "demo";
  search(query: string): CatalogProduct[];
  select(productId: string, quantity: number): CartSnapshot;
  readCart(): CartSnapshot;
  updateCart(productId: string, quantity: number): CartSnapshot;
  quote(): QuoteSnapshot;
  orderStatus(orderId: string): ProviderOrder | null;
}

const INSTAMART: readonly CatalogProduct[] = [
  { id: "milk", name: "Amul Taaza Milk 1 L", unitPrice: 66 },
  { id: "bread", name: "Harvest Brown Bread", unitPrice: 40 },
  { id: "tomato", name: "Tomato 500 g", unitPrice: null },
];

const FOOD: readonly CatalogProduct[] = [
  { id: "dosa", name: "Masala Dosa", unitPrice: 120 },
  { id: "idli", name: "Idli", unitPrice: 80 },
  { id: "thali", name: "Chef Thali", unitPrice: null },
];

export function createMockCommerce(provider: CommerceProvider, ids: () => string): MockCommerce {
  switch (provider) {
    case "instamart":
      return new MockCommerce(provider, 25, INSTAMART, ids);
    case "swiggy-food":
      return new MockCommerce(provider, 30, FOOD, ids);
    default: {
      const neverProvider: never = provider;
      return neverProvider;
    }
  }
}

export class MockCommerce implements CommerceAdapter {
  readonly provenance = "demo" as const;
  readonly provider: CommerceProvider;
  private readonly catalog: CatalogProduct[];
  private readonly quantities = new Map<string, number>();
  private readonly orders = new Map<string, ProviderOrder>();
  private readonly deliveryFee: number;
  private readonly ids: () => string;

  constructor(provider: CommerceProvider, deliveryFee: number, catalog: readonly CatalogProduct[], ids: () => string) {
    this.provider = provider;
    this.deliveryFee = deliveryFee;
    this.catalog = catalog.map((item) => ({ ...item }));
    this.ids = ids;
  }

  search(query: string): CatalogProduct[] {
    const needle = query.trim().toLowerCase();
    if (needle.length < 2) return [];
    return this.catalog.filter((item) => item.name.toLowerCase().includes(needle) || item.id === needle);
  }

  select(productId: string, quantity: number): CartSnapshot {
    return this.updateCart(productId, quantity);
  }

  updateCart(productId: string, quantity: number): CartSnapshot {
    if (!this.catalog.some((item) => item.id === productId)) return this.readCart();
    if (!Number.isInteger(quantity) || quantity <= 0) this.quantities.delete(productId);
    else this.quantities.set(productId, quantity);
    return this.readCart();
  }

  readCart(): CartSnapshot {
    const lines: CartLine[] = [];
    for (const product of this.catalog) {
      const quantity = this.quantities.get(product.id);
      if (quantity == null) continue;
      lines.push({
        id: product.id,
        name: product.name,
        quantity,
        unitPrice: product.unitPrice,
        lineTotal: lineTotal(product.unitPrice, quantity),
      });
    }
    const deliveryFee = lines.length === 0 ? null : this.deliveryFee;
    return {
      provider: this.provider,
      provenance: "demo",
      simulated: true,
      lines,
      deliveryFee,
      total: cartTotal(lines, deliveryFee),
    };
  }

  quote(): QuoteSnapshot {
    const cart = this.readCart();
    const seller = providerLabel(this.provider);
    return {
      id: this.ids(),
      domain: "order",
      provider: seller,
      provenance: "demo",
      simulated: true,
      title: "Checkout review",
      lines: cart.lines.map((line) => ({ label: line.name, quantity: line.quantity, amount: line.lineTotal })),
      deliveryFee: cart.deliveryFee,
      total: cart.total,
      details: [
        { label: "Order", value: outcomeLabel("demo", "order") },
        { label: "Seller", value: seller },
      ],
    };
  }

  recordOrder(orderId: string): ProviderOrder {
    const existing = this.orders.get(orderId);
    if (existing) return existing;
    const order: ProviderOrder = { id: orderId, status: "accepted", provenance: "demo" };
    this.orders.set(orderId, order);
    return order;
  }

  orderStatus(orderId: string): ProviderOrder | null {
    return this.orders.get(orderId) ?? null;
  }

  setUnitPrice(productId: string, unitPrice: number | null): void {
    const product = this.catalog.find((item) => item.id === productId);
    if (product) product.unitPrice = unitPrice;
  }
}
