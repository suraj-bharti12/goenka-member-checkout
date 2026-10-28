// Pure calculation logic — no network. Kept separate so it can be tested locally.

export const MEMBER_DIAMOND_PERCENT = 20; // 20% of diamond value

function parseJson(value) {
  if (value == null) return null;
  if (typeof value === "object") return value;
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

function round2(n) {
  return Math.round(n * 100) / 100;
}

/**
 * Diamond value of ONE unit of a variant, from GPE data.
 * Same formula GPE uses for the "Diamonds" row of the price breakup:
 *   sum over diamond stones of (stone_weight × slab price per carat)
 *
 * @param {object|string} variantConfig  DI-GoldPrice.variant_config
 * @param {array|string}  stonePricing   DI-GoldPrice.stone_pricing (shop)
 * @returns {{ value: number, parts: Array }}
 */
export function diamondValue(variantConfig, stonePricing) {
  const cfg = parseJson(variantConfig);
  const pricing = parseJson(stonePricing) || [];
  const parts = [];
  if (!cfg) return { value: 0, parts };

  // Manual "Diamond Price" entered in GPE overrides the stone configuration.
  const manual = Number(cfg.diamond_charges);
  if (cfg.diamond_charges != null && Number.isFinite(manual) && manual > 0) {
    parts.push({ source: "manual_diamond_price", value: round2(manual) });
    return { value: round2(manual), parts };
  }

  const stones = Array.isArray(cfg.advanced_stone_config) ? cfg.advanced_stone_config : [];
  let total = 0;
  for (const s of stones) {
    if (String(s.stone_type || "").toLowerCase() !== "diamond") continue; // gemstones excluded
    const weight = Number(s.stone_weight);
    if (!Number.isFinite(weight) || weight <= 0) continue;

    const def = pricing.find((p) => String(p.id) === String(s.pricing_id));
    if (!def || String(def.stone_type || "").toLowerCase() !== "diamond") continue;

    const slabs = Array.isArray(def.slabs) ? def.slabs : [];
    const slab = slabs.find(
      (sl) => weight >= Number(sl.from_weight) && weight <= Number(sl.to_weight)
    );
    if (!slab) continue;

    const rate = Number(slab.price) || 0;
    const slabDiscount = Number(slab.discount) || 0; // GPE per-slab % discount
    const value = weight * rate * (1 - slabDiscount / 100);
    total += value;
    parts.push({ pricing_id: s.pricing_id, weight, rate, value: round2(value) });
  }
  return { value: round2(total), parts };
}

/**
 * Member discount for ONE unit.
 * Never more than MEMBER_DIAMOND_PERCENT% of the unit selling price (safety cap).
 */
export function memberDiscountPerUnit(unitPrice, variantConfig, stonePricing) {
  const { value, parts } = diamondValue(variantConfig, stonePricing);
  const price = Number(unitPrice) || 0;
  let discount = (value * MEMBER_DIAMOND_PERCENT) / 100;
  const cap = (price * MEMBER_DIAMOND_PERCENT) / 100;
  if (discount > cap) discount = cap;
  if (discount < 0) discount = 0;
  return { diamondValue: value, discount: round2(discount), parts };
}
