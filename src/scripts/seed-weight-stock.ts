import { ExecArgs } from "@medusajs/framework/types"
import { ContainerRegistrationKeys, Modules } from "@medusajs/framework/utils"
import { parseWeightKg } from "../utils/weight"

// ---------------------------------------------------------------------------
// Product definitions — add / edit products here.
// Each inventory item uses 1 unit = 1 kg.
// required_quantity on the variant link = the bag weight in kg.
// ---------------------------------------------------------------------------

const PRODUCTS = [
  {
    title: "Apples",
    handle: "apples",
    description: "Fresh apples available in bulk bags.",
    inventorySku: "APPLES-KG",   // one inventory item per product
    initialKg: 1000,
    variants: [
      { title: "20kg", sku: "APPLES-20KG", priceUsd: 2000 },
      { title: "40kg", sku: "APPLES-40KG", priceUsd: 3800 },
      { title: "60kg", sku: "APPLES-60KG", priceUsd: 5400 },
    ],
  },
  {
    title: "Pears",
    handle: "pears",
    description: "Fresh pears available in bulk bags.",
    inventorySku: "PEARS-KG",
    initialKg: 500,
    variants: [
      { title: "15kg", sku: "PEARS-15KG", priceUsd: 1500 },
      { title: "30kg", sku: "PEARS-30KG", priceUsd: 2800 },
      { title: "50kg", sku: "PEARS-50KG", priceUsd: 4500 },
    ],
  },
  // Add more products here — no other code changes needed.
]

// ---------------------------------------------------------------------------

export default async function seedWeightStock({ container }: ExecArgs) {
  const logger = container.resolve(ContainerRegistrationKeys.LOGGER)
  const link = container.resolve(ContainerRegistrationKeys.LINK)   // replaces deprecated REMOTE_LINK
  const query = container.resolve(ContainerRegistrationKeys.QUERY)
  const productModule = container.resolve(Modules.PRODUCT)
  const inventoryModule = container.resolve(Modules.INVENTORY)
  const stockLocModule = container.resolve(Modules.STOCK_LOCATION)
  const salesChannelModule = container.resolve(Modules.SALES_CHANNEL)

  // ── 1. Ensure a stock location exists ──────────────────────────────────
  logger.info("Checking stock locations…")

  const existingLocations = await stockLocModule.listStockLocations({})
  let location = existingLocations[0]

  if (!location) {
    location = await stockLocModule.createStockLocations({
      name: "Main Warehouse",
    })
    logger.info(`Created stock location: ${location.name} (${location.id})`)
  } else {
    logger.info(`Using existing location: ${location.name} (${location.id})`)
  }

  // ── 2. Ensure a default sales channel exists ────────────────────────────
  const existingChannels = await salesChannelModule.listSalesChannels({})
  let salesChannel = existingChannels[0]

  if (!salesChannel) {
    salesChannel = await salesChannelModule.createSalesChannels({
      name: "Default Sales Channel",
    })
    logger.info(`Created sales channel: ${salesChannel.id}`)
  }

  // ── 3. Seed each product ────────────────────────────────────────────────
  for (const def of PRODUCTS) {
    logger.info(`\nSeeding: ${def.title}`)

    // -- 3a. Create product (skip if handle already exists) ----------------
    const [existing] = await productModule.listProducts({ handle: def.handle })
    let product = existing

    if (!product) {
      product = await productModule.createProducts({
        title: def.title,
        handle: def.handle,
        description: def.description,
        status: "published",
        options: [{ title: "Bag Size", values: def.variants.map(v => v.title) }],
        variants: def.variants.map(v => ({
          title: v.title,
          sku: v.sku,
          manage_inventory: true,  // ← tells Medusa to check our inventory item
          allow_backorder: false,
          options: { "Bag Size": v.title },
          prices: [{ amount: v.priceUsd, currency_code: "usd" }],
        })),
      })
      logger.info(`  Created product ${product.id} with ${product.variants.length} variants`)
    } else {
      logger.info(`  Product already exists (${product.id}), skipping creation`)
    }

    // -- 3b. Create inventory item (1 unit = 1 kg) -------------------------
    const existingItems = await inventoryModule.listInventoryItems({ sku: def.inventorySku })
    let inventoryItem = existingItems[0]

    if (!inventoryItem) {
      inventoryItem = await inventoryModule.createInventoryItems({
        title: `${def.title} — bulk stock (1 unit = 1 kg)`,
        sku: def.inventorySku,
        description: `Weight-based inventory for ${def.title}. 1 inventory unit = 1 kg.`,
        metadata: {
          weight_based: true,
          product_id: product.id,
          product_title: def.title,
        },
      })
      logger.info(`  Created inventory item ${inventoryItem.id} (sku: ${def.inventorySku})`)
    } else {
      logger.info(`  Inventory item already exists (${inventoryItem.id}), skipping`)
    }

    // -- 3c. Set initial stock at location ----------------------------------
    const existingLevels = await inventoryModule.listInventoryLevels({
      inventory_item_id: inventoryItem.id,
      location_id: location.id,
    })

    if (existingLevels.length === 0) {
      await inventoryModule.createInventoryLevels({
        inventory_item_id: inventoryItem.id,
        location_id: location.id,
        stocked_quantity: def.initialKg,  // 1000 units = 1000 kg
      })
      logger.info(`  Set initial stock: ${def.initialKg} kg at ${location.name}`)
    } else {
      logger.info(`  Stock level already set (${existingLevels[0].stocked_quantity} kg), skipping`)
    }

    // -- 3d. Link each variant → inventory item with required_quantity ------
    // required_quantity = bag weight in kg
    // Medusa checks: available_units >= required_quantity before allowing purchase
    const [freshProduct] = await productModule.listProducts(
      { id: product.id },
      { relations: ["variants"] }
    )

    for (const variant of freshProduct.variants) {
      const weightKg = parseWeightKg(variant.title)
      if (!weightKg) {
        logger.warn(`  Skipping variant "${variant.title}" — not a weight variant`)
        continue
      }

      // Check if link already exists using query.graph (listInventoryItemVariants
      // does not exist on IInventoryService)
      const { data: [variantData] } = await query.graph({
        entity: "variant",
        fields: ["id", "inventory_items.id"],
        filters: { id: variant.id },
      })

      const alreadyLinked = (variantData?.inventory_items ?? []).length > 0
      if (alreadyLinked) {
        logger.info(`  Variant ${variant.title} already linked, skipping`)
        continue
      }

      await link.create([
        {
          [Modules.PRODUCT]: { variant_id: variant.id },
          [Modules.INVENTORY]: { inventory_item_id: inventoryItem.id },
          data: { required_quantity: weightKg },
        },
      ])

      logger.info(`  Linked ${variant.title} → inventory item (requires ${weightKg} units per sale)`)
    }

    logger.info(`  ✓ ${def.title} seeded`)
  }

  logger.info("\n✅ Weight stock seed complete.")
  logger.info("How it works:")
  logger.info("  1 inventory unit = 1 kg")
  logger.info("  20kg variant requires 20 units — Medusa checks availability automatically")
  logger.info("  Reservations and deductions are handled by Medusa on order place / fulfil")
}
