import { randomBytes, randomInt } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { SKILLS, type WebsiteSkill } from "../../src/server/browser/skills.ts";

type Product = { id: string; title: string; paise: number };

/**
 * A small quick-commerce site for end-to-end tests: phone sign-in with an SMS
 * code, search, add to cart, quantity, fees, checkout with an autopay trap,
 * a UPI link, and an orders page that confirms only after payment.
 */
export class FixtureMerchant {
  readonly sms: { phone: string; code: string }[] = [];
  readonly payClicks: string[] = [];
  autopayPressed = false;
  private readonly products = new Map<string, Product>([
    ["milk", { id: "milk", title: "Amul Taaza Milk 500 ml", paise: 3300 }],
    ["gold", { id: "gold", title: "Amul Gold Milk 1 l", paise: 6800 }],
    ["bread", { id: "bread", title: "Harvest Gold Bread", paise: 4000 }],
  ]);
  private readonly pending = new Map<string, string>();
  private readonly sessions = new Map<string, string>();
  private readonly carts = new Map<string, Map<string, number>>();
  private readonly orders = new Map<string, { id: string; paid: boolean; sid: string }>();
  private server: Server | null = null;
  base = "";

  async start(): Promise<void> {
    this.server = createServer((request, response) => {
      void this.route(request, response).catch(() => {
        response.writeHead(500).end("error");
      });
    });
    await new Promise<void>((resolve) => this.server?.listen(0, "127.0.0.1", resolve));
    const address = this.server.address() as AddressInfo;
    this.base = `http://127.0.0.1:${address.port}`;
  }

  async stop(): Promise<void> {
    await new Promise<void>((resolve) => this.server?.close(() => resolve()));
  }

  skill(): WebsiteSkill {
    const base = this.base;
    return {
      ...SKILLS.blinkit,
      id: "blinkit",
      name: "Fixture Mart",
      domains: ["127.0.0.1"],
      home: `${base}/`,
      search: { url: (q) => `${base}/s?q=${encodeURIComponent(q)}`, box: /search/i },
      cart: { ...SKILLS.blinkit.cart, open: /^cart$/i, url: `${base}/cart`, increase: /^increase$/i },
      checkout: { ...SKILLS.blinkit.checkout, proceed: /^proceed to checkout$/i, payInitiation: /^pay now$/i },
      success: { ...SKILLS.blinkit.success, ordersUrl: `${base}/orders` },
    };
  }

  setPrice(id: string, paise: number): void {
    const product = this.products.get(id);
    if (product) product.paise = paise;
  }

  markAllPaid(): void {
    for (const order of this.orders.values()) order.paid = true;
  }

  expireSessions(): void {
    this.sessions.clear();
  }

  orderCount(): number {
    return this.orders.size;
  }

  private async route(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const url = new URL(request.url ?? "/", this.base);
    const sid = cookie(request, "sid");
    const signedIn = sid != null && this.sessions.has(sid);
    const body = request.method === "POST" ? await form(request) : new URLSearchParams();
    const cartKey = sid ?? cookie(request, "guest") ?? "";
    switch (`${request.method} ${url.pathname}`) {
      case "GET /":
        return page(response, "Fixture Mart", `
          ${signedIn ? `<a href="/orders">My orders</a> <a href="/logout">Log out</a>` : `<a href="/login">Login</a>`}
          <form action="/s"><input aria-label="Search products" name="q"><button>Search</button></form>`);
      case "GET /login":
        return page(response, "Login", `<form method="post" action="/login"><label>Phone number <input name="phone"></label><button>Continue</button></form>`);
      case "POST /login": {
        const phone = body.get("phone") ?? "";
        if (!/^\d{10}$/.test(phone)) return page(response, "Login", `<p>Enter a 10-digit number</p>`);
        const code = String(randomInt(100000, 999999));
        this.pending.set(phone, code);
        this.sms.push({ phone, code });
        return redirect(response, "/verify", [`pending=${phone}; Path=/; HttpOnly`]);
      }
      case "GET /verify":
        return page(response, "Verify", `<form method="post" action="/verify"><label>Enter OTP <input name="otp"></label><button>Verify</button></form>`);
      case "POST /verify": {
        const phone = cookie(request, "pending") ?? "";
        if (!phone || this.pending.get(phone) !== body.get("otp")) return page(response, "Verify", `<p>Wrong code</p><form method="post" action="/verify"><label>Enter OTP <input name="otp"></label><button>Verify</button></form>`);
        this.pending.delete(phone);
        const token = randomBytes(12).toString("hex");
        this.sessions.set(token, phone);
        const guest = cookie(request, "guest");
        if (guest && this.carts.has(guest)) this.carts.set(token, this.carts.get(guest) ?? new Map());
        return redirect(response, "/", [`sid=${token}; Path=/; HttpOnly; Max-Age=86400`]);
      }
      case "GET /s": {
        const q = (url.searchParams.get("q") ?? "").toLowerCase();
        const cart = this.carts.get(cartKey) ?? new Map<string, number>();
        const rows = [...this.products.values()].filter((item) => q.split(/\s+/).every((word) => item.title.toLowerCase().includes(word))).map((item) => `
          <div><a href="/p/${item.id}">${item.title} ₹${item.paise / 100}</a>
          ${cart.has(item.id)
            ? `<form method="post" action="/cart/inc"><input type="hidden" name="id" value="${item.id}"><input type="hidden" name="back" value="${url.pathname}${url.search}"><button aria-label="increase">+</button></form> <span>${cart.get(item.id)} in cart</span>`
            : `<form method="post" action="/cart/add"><input type="hidden" name="id" value="${item.id}"><input type="hidden" name="back" value="${url.pathname}${url.search}"><button>ADD</button></form>`}</div>`).join("");
        const setGuest = sid == null && cookie(request, "guest") == null ? [`guest=${randomBytes(8).toString("hex")}; Path=/`] : [];
        return page(response, "Search", `${rows}<a href="/cart">Cart</a>`, setGuest);
      }
      case "POST /cart/add":
      case "POST /cart/inc": {
        const id = body.get("id") ?? "";
        if (!this.products.has(id) || !cartKey) return redirect(response, "/");
        const cart = this.carts.get(cartKey) ?? new Map<string, number>();
        cart.set(id, (cart.get(id) ?? 0) + 1);
        this.carts.set(cartKey, cart);
        return redirect(response, body.get("back") ?? "/cart");
      }
      case "GET /cart":
        return page(response, "Cart", `${this.bill(cartKey)}<a href="/checkout">Proceed to checkout</a>`);
      case "GET /checkout":
        if (!signedIn) return redirect(response, "/login");
        return page(response, "Checkout", `${this.bill(cartKey, "To pay")}
          <form method="post" action="/autopay"><button>Enable autopay</button></form>
          <form method="post" action="/pay"><button>Pay now</button></form>`);
      case "POST /autopay":
        this.autopayPressed = true;
        return redirect(response, "/checkout");
      case "POST /pay": {
        if (!signedIn || !sid) return redirect(response, "/login");
        const id = `FX${randomInt(100000, 999999)}`;
        this.orders.set(id, { id, paid: false, sid });
        this.payClicks.push(id);
        const total = this.total(cartKey) / 100;
        return page(response, "Pay", `<p>Open your UPI app to pay ₹${total}</p><a href="upi://pay?pa=fixture@upi&amp;pn=Fixture%20Mart&amp;am=${total}.00&amp;tr=${id}&amp;cu=INR">Pay with UPI</a>`);
      }
      case "GET /orders": {
        if (!signedIn) return redirect(response, "/login");
        const mine = [...this.orders.values()].filter((order) => order.sid === sid);
        const lines = mine.map((order) => order.paid ? `<p>Order confirmed. Order ID: ${order.id}</p>` : `<p>Payment pending for ${order.id}</p>`).join("");
        return page(response, "Orders", lines || "<p>No orders</p>");
      }
      default:
        response.writeHead(404).end("not found");
    }
  }

  private bill(cartKey: string, totalLabel = "Grand total"): string {
    const cart = this.carts.get(cartKey) ?? new Map<string, number>();
    const lines = [...cart.entries()].map(([id, count]) => {
      const product = this.products.get(id);
      return product ? `<div>${product.title} × ${count} ₹${(product.paise * count) / 100}</div>` : "";
    }).join("");
    return `${lines}<div>Item total ₹${this.items(cartKey) / 100}</div><div>Delivery fee ₹25</div><div>${totalLabel} ₹${this.total(cartKey) / 100}</div>`;
  }

  private items(cartKey: string): number {
    const cart = this.carts.get(cartKey) ?? new Map<string, number>();
    return [...cart.entries()].reduce((sum, [id, count]) => sum + (this.products.get(id)?.paise ?? 0) * count, 0);
  }

  private total(cartKey: string): number {
    return this.items(cartKey) + 2500;
  }
}

function page(response: ServerResponse, title: string, body: string, cookies: string[] = []): void {
  response.writeHead(200, { "content-type": "text/html; charset=utf-8", ...(cookies.length > 0 ? { "set-cookie": cookies } : {}) });
  response.end(`<!doctype html><html><head><title>${title}</title></head><body><main>${body}</main></body></html>`);
}

function redirect(response: ServerResponse, location: string, cookies: string[] = []): void {
  response.writeHead(303, { location, ...(cookies.length > 0 ? { "set-cookie": cookies } : {}) });
  response.end();
}

function cookie(request: IncomingMessage, name: string): string | null {
  const header = request.headers.cookie ?? "";
  for (const part of header.split(";")) {
    const [key, ...rest] = part.trim().split("=");
    if (key === name) return rest.join("=");
  }
  return null;
}

async function form(request: IncomingMessage): Promise<URLSearchParams> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(chunk as Buffer);
  return new URLSearchParams(Buffer.concat(chunks).toString("utf8"));
}
