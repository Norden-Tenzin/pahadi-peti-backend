import { defineWidgetConfig } from "@medusajs/admin-sdk"
import { DetailWidgetProps, AdminProduct } from "@medusajs/framework/types"
import { useState, useEffect } from "react"
import {
  Container,
  Heading,
  Text,
  Badge,
  Button,
  Input,
  Label,
  toast,
  Toaster,
} from "@medusajs/ui"
import { parseWeightKg } from "../../utils/weight"

type LocationLevel = {
  location_id: string
  stocked_quantity: number
  reserved_quantity: number
  available_quantity: number
}

type InventoryItem = {
  id: string
  title: string
  sku: string
  metadata: Record<string, any> | null
  location_levels: LocationLevel[]
}

/**
 * Shown in the sidebar of every product detail page.
 * Finds the product's weight-based inventory item via metadata.product_id
 * and shows available kg + a quick adjust control.
 * Hides itself if the product has no weight inventory.
 */
function ProductWeightStockWidget({ data: product }: DetailWidgetProps<AdminProduct>) {
  const [item, setItem] = useState<InventoryItem | null>(null)
  const [notFound, setNotFound] = useState(false)
  const [delta, setDelta] = useState("")
  const [loading, setLoading] = useState(false)

  async function loadItem() {
    try {
      // Fetch all weight-based inventory items, find this product's
      const res = await fetch(
        `/admin/inventory-items?limit=100&fields=id,title,sku,+metadata,+location_levels.stocked_quantity,+location_levels.reserved_quantity,+location_levels.available_quantity,+location_levels.location_id`,
        { credentials: "include" }
      )
      const data = await res.json()
      const found = (data.inventory_items ?? []).find(
        (i: InventoryItem) =>
          (i.metadata?.weight_based === true || i.metadata?.weight_based === "true") &&
          String(i.metadata?.product_id) === product.id
      )
      if (!found) { setNotFound(true); return }
      setItem(found)
    } catch {
      setNotFound(true)
    }
  }

  useEffect(() => { loadItem() }, [product.id])

  if (notFound) return null // not a weight-managed product — hide widget

  if (!item) return (
    <Container>
      <Text className="text-ui-fg-subtle text-sm">Loading weight stock…</Text>
    </Container>
  )

  const levels = item.location_levels ?? []
  const stocked = levels.reduce((s, l) => s + l.stocked_quantity, 0)
  const reserved = levels.reduce((s, l) => s + l.reserved_quantity, 0)
  const available = levels.reduce((s, l) => s + l.available_quantity, 0)
  const firstLevel = levels[0]

  // Work out which variants are available given current stock
  const weightVariants = (product.variants ?? []).flatMap(v => {
    const kg = parseWeightKg(v.title)
    if (!kg) return []
    return [{ title: v.title, kg, available: available >= kg }]
  })

  async function quickAdjust() {
    if (!firstLevel) return toast.error("No stock location found.")
    const num = parseFloat(delta)
    if (isNaN(num)) return toast.error("Enter a valid number.")

    const newQty = firstLevel.stocked_quantity + num
    if (newQty < 0) return toast.error("Stock cannot go negative.")

    setLoading(true)
    try {
      const res = await fetch(
        `/admin/inventory-items/${item!.id}/location-levels/${firstLevel.location_id}`,
        {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          credentials: "include",
          body: JSON.stringify({ stocked_quantity: newQty }),
        }
      )
      if (!res.ok) throw new Error("Update failed")
      toast.success(`Stock updated to ${newQty} kg`)
      setDelta("")
      await loadItem()
    } catch (e: any) {
      toast.error(e.message)
    } finally {
      setLoading(false)
    }
  }

  return (
    <Container>
      <Toaster />
      <Heading level="h3" className="mb-4">Weight Stock</Heading>

      {/* KG summary */}
      <div className="grid grid-cols-3 gap-2 text-center mb-4">
        {[
          { label: "Total", value: stocked },
          { label: "Reserved", value: reserved },
          { label: "Available", value: available },
        ].map(({ label, value }) => (
          <div key={label} className="bg-ui-bg-subtle rounded p-2">
            <Text className="text-xs text-ui-fg-subtle">{label}</Text>
            <Text className="font-semibold">{value.toLocaleString()} kg</Text>
          </div>
        ))}
      </div>

      {/* Per-variant availability */}
      {weightVariants.length > 0 && (
        <div className="space-y-1 mb-4">
          {weightVariants.map(v => (
            <div key={v.title} className="flex justify-between text-sm">
              <span className="text-ui-fg-subtle">{v.title}</span>
              <Badge color={v.available ? "green" : "red"} size="xsmall">
                {v.available ? "Available" : "Out of stock"}
              </Badge>
            </div>
          ))}
        </div>
      )}

      {/* Quick adjust */}
      {firstLevel && (
        <div className="border-t border-ui-border-base pt-3 space-y-2">
          <Label className="text-xs font-medium text-ui-fg-subtle uppercase tracking-wide">
            Quick adjust (kg)
          </Label>
          <Input
            type="number"
            placeholder="e.g. +500 or -60"
            value={delta}
            onChange={e => setDelta(e.target.value)}
            size="small"
          />
          <Button size="small" onClick={quickAdjust} isLoading={loading} className="w-full">
            Apply
          </Button>
        </div>
      )}

      <Button
        variant="transparent"
        size="small"
        className="w-full mt-2 text-ui-fg-interactive"
        onClick={() => (window.location.href = "/a/weight-stock")}
      >
        Full inventory view →
      </Button>
    </Container>
  )
}

export default ProductWeightStockWidget

export const config = defineWidgetConfig({
  zone: "product.details.side.before",
})
