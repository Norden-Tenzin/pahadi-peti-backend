import { defineRouteConfig } from "@medusajs/admin-sdk"
import { Package } from "lucide-react"
import { useState, useEffect, useCallback, useRef } from "react"
import {
  Container,
  Heading,
  Text,
  Badge,
  Button,
  Input,
  Label,
  Table,
  toast,
  Toaster,
} from "@medusajs/ui"
import { parseWeightKg } from "../../../utils/weight"

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type LocationLevel = {
  id: string
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
  location_levels?: LocationLevel[]
}

type StockLocation = {
  id: string
  name: string
}

type ProductVariant = {
  id: string
  title: string
  sku: string | null
  manage_inventory: boolean
}

type Product = {
  id: string
  title: string
  handle: string
  variants: ProductVariant[]
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function sumLevels(levels: LocationLevel[] = []) {
  return {
    stocked: levels.reduce((s, l) => s + l.stocked_quantity, 0),
    reserved: levels.reduce((s, l) => s + l.reserved_quantity, 0),
    available: levels.reduce((s, l) => s + l.available_quantity, 0),
  }
}

async function adminFetch(path: string, opts: RequestInit = {}) {
  const res = await fetch(path, { credentials: "include", ...opts })
  if (!res.ok) {
    const err = await res.json().catch(() => ({}))
    throw new Error(err.message ?? `Request failed: ${res.status}`)
  }
  return res.json()
}

// ---------------------------------------------------------------------------
// Enroll Product Modal
// ---------------------------------------------------------------------------
// Walks through 3 steps:
//   1. Search & select a product
//   2. Review weight variants + set initial kg
//   3. Creating (loading state)
//
// On submit it:
//   a. Creates an inventory item (1 unit = 1 kg)
//   b. Creates a stock level at the chosen location
//   c. Links each weight variant → inventory item with required_quantity = weight
//   d. Sets manage_inventory = true on those variants

function EnrollModal({
  locations,
  onClose,
  onDone,
}: {
  locations: StockLocation[]
  onClose: () => void
  onDone: () => void
}) {
  const [step, setStep] = useState<"search" | "review" | "creating">("search")
  const [search, setSearch] = useState("")
  const [searchResults, setSearchResults] = useState<Product[]>([])
  const [selected, setSelected] = useState<Product | null>(null)
  const [locationId, setLocationId] = useState(locations[0]?.id ?? "")
  const [initialKg, setInitialKg] = useState("")
  const [searching, setSearching] = useState(false)
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  // Derived: which of the selected product's variants are weight-based
  const weightVariants = (selected?.variants ?? []).flatMap(v => {
    const kg = parseWeightKg(v.title)
    if (!kg) return []
    return [{ ...v, kg }]
  })

  // Debounced product search
  useEffect(() => {
    if (!search.trim()) { setSearchResults([]); return }
    if (debounceRef.current) clearTimeout(debounceRef.current)
    debounceRef.current = setTimeout(async () => {
      setSearching(true)
      try {
        const data = await adminFetch(
          `/admin/products?q=${encodeURIComponent(search)}&limit=8&fields=id,title,handle,+variants.id,+variants.title,+variants.sku,+variants.manage_inventory`
        )
        setSearchResults(data.products ?? [])
      } catch {
        setSearchResults([])
      } finally {
        setSearching(false)
      }
    }, 300)
  }, [search])

  async function enroll() {
    if (!selected || !locationId) return
    const kg = parseFloat(initialKg)
    if (isNaN(kg) || kg <= 0) return toast.error("Enter a valid initial stock in kg.")
    if (weightVariants.length === 0) return toast.error("No weight variants found on this product.")

    setStep("creating")
    try {
      // 1. Create inventory item
      const itemSku = `${selected.handle.toUpperCase().replace(/-/g, "_")}-KG`
      const { inventory_item: inventoryItem } = await adminFetch(
        "/admin/inventory-items",
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            title: `${selected.title} — bulk stock (1 unit = 1 kg)`,
            sku: itemSku,
            description: `Weight-based inventory for ${selected.title}. 1 inventory unit = 1 kg.`,
            metadata: {
              weight_based: true,
              product_id: selected.id,
              product_title: selected.title,
            },
          }),
        }
      )

      // 2. Set initial stock at the chosen location
      await adminFetch(
        `/admin/inventory-items/${inventoryItem.id}/location-levels`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            location_id: locationId,
            stocked_quantity: kg,
          }),
        }
      )

      // 3. For each weight variant:
      //    - enable manage_inventory
      //    - link to the inventory item with required_quantity = weight_kg
      for (const variant of weightVariants) {
        // Enable inventory management on the variant
        await adminFetch(
          `/admin/products/${selected.id}/variants/${variant.id}`,
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              manage_inventory: true,
              allow_backorder: false,
            }),
          }
        )

        // Link variant → inventory item with required_quantity
        await adminFetch(
          `/admin/products/${selected.id}/variants/${variant.id}/inventory-items`,
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              inventory_item_id: inventoryItem.id,
              required_quantity: variant.kg,
            }),
          }
        )
      }

      toast.success(`${selected.title} enrolled with ${kg} kg initial stock.`)
      onDone()
    } catch (e: any) {
      toast.error(e.message)
      setStep("review")
    }
  }

  return (
    // Backdrop
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40">
      <div className="bg-ui-bg-base rounded-lg shadow-xl w-full max-w-lg mx-4 overflow-hidden">

        {/* Header */}
        <div className="flex items-center justify-between p-6 border-b border-ui-border-base">
          <Heading level="h2">Enroll Product in Weight Stock</Heading>
          <Button variant="transparent" size="small" onClick={onClose}>✕</Button>
        </div>

        {/* Body */}
        <div className="p-6 space-y-5">

          {/* ── Step: search ──────────────────────────────────────── */}
          {(step === "search" || step === "review") && (
            <div className="space-y-2">
              <Label>Search product</Label>
              <Input
                placeholder="Type product name…"
                value={search}
                onChange={e => {
                  setSearch(e.target.value)
                  setSelected(null)
                  setStep("search")
                }}
                autoFocus
              />

              {searching && (
                <Text className="text-ui-fg-subtle text-sm">Searching…</Text>
              )}

              {!selected && searchResults.length > 0 && (
                <div className="border border-ui-border-base rounded overflow-hidden">
                  {searchResults.map(p => (
                    <button
                      key={p.id}
                      className="w-full text-left px-4 py-3 hover:bg-ui-bg-base-hover border-b border-ui-border-base last:border-b-0 transition-colors"
                      onClick={() => {
                        setSelected(p)
                        setSearch(p.title)
                        setSearchResults([])
                        setStep("review")
                      }}
                    >
                      <Text className="font-medium">{p.title}</Text>
                      <Text className="text-ui-fg-subtle text-xs">{p.handle}</Text>
                    </button>
                  ))}
                </div>
              )}
            </div>
          )}

          {/* ── Step: review ──────────────────────────────────────── */}
          {step === "review" && selected && (
            <>
              {/* Weight variants preview */}
              <div className="space-y-2">
                <Label>Weight variants detected</Label>
                {weightVariants.length === 0 ? (
                  <div className="bg-ui-bg-subtle rounded p-3">
                    <Text className="text-red-500 text-sm">
                      No variants with weight titles found (e.g. "20kg", "40kg").
                      Rename your variants to match the pattern before enrolling.
                    </Text>
                  </div>
                ) : (
                  <div className="bg-ui-bg-subtle rounded p-3 space-y-1">
                    {weightVariants.map(v => (
                      <div key={v.id} className="flex justify-between text-sm">
                        <span>{v.title}</span>
                        <Badge color="blue" size="xsmall">requires {v.kg} units / sale</Badge>
                      </div>
                    ))}
                    {selected.variants.filter(v => !parseWeightKg(v.title)).map(v => (
                      <div key={v.id} className="flex justify-between text-sm opacity-40">
                        <span>{v.title}</span>
                        <span className="text-xs">skipped — not a weight variant</span>
                      </div>
                    ))}
                  </div>
                )}
              </div>

              {/* Initial stock */}
              <div className="space-y-1">
                <Label>Initial stock (kg)</Label>
                <Input
                  type="number"
                  placeholder="e.g. 1000"
                  value={initialKg}
                  onChange={e => setInitialKg(e.target.value)}
                />
                <Text className="text-ui-fg-subtle text-xs">
                  1 inventory unit = 1 kg. Medusa reserves and deducts units automatically on orders.
                </Text>
              </div>

              {/* Location selector */}
              {locations.length > 1 && (
                <div className="space-y-1">
                  <Label>Stock location</Label>
                  <select
                    className="w-full border border-ui-border-base rounded px-3 py-2 text-sm bg-ui-bg-base"
                    value={locationId}
                    onChange={e => setLocationId(e.target.value)}
                  >
                    {locations.map(l => (
                      <option key={l.id} value={l.id}>{l.name}</option>
                    ))}
                  </select>
                </div>
              )}
              {locations.length === 1 && (
                <Text className="text-ui-fg-subtle text-xs">
                  Location: <span className="font-medium">{locations[0].name}</span>
                </Text>
              )}
            </>
          )}

          {/* ── Step: creating ────────────────────────────────────── */}
          {step === "creating" && (
            <div className="text-center py-6 space-y-2">
              <Text className="font-medium">Setting up weight inventory…</Text>
              <Text className="text-ui-fg-subtle text-sm">
                Creating inventory item, setting stock level, and linking variants.
              </Text>
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="flex justify-end gap-3 px-6 py-4 border-t border-ui-border-base bg-ui-bg-subtle">
          <Button variant="secondary" onClick={onClose} disabled={step === "creating"}>
            Cancel
          </Button>
          <Button
            onClick={enroll}
            disabled={
              step !== "review" ||
              !selected ||
              weightVariants.length === 0 ||
              !initialKg ||
              step === "creating"
            }
            isLoading={step === "creating"}
          >
            Enroll product
          </Button>
        </div>
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Adjust stock form
// ---------------------------------------------------------------------------

function AdjustForm({ item, onDone }: { item: InventoryItem; onDone: () => void }) {
  const levels = item.location_levels ?? []
  const [selectedLevel, setSelectedLevel] = useState<LocationLevel | null>(levels[0] ?? null)
  const [mode, setMode] = useState<"adjust" | "set">("adjust")
  const [value, setValue] = useState("")
  const [loading, setLoading] = useState(false)

  async function submit() {
    if (!selectedLevel) return toast.error("No stock location found.")
    const num = parseFloat(value)
    if (isNaN(num)) return toast.error("Enter a valid number.")
    const newQty = mode === "set" ? num : selectedLevel.stocked_quantity + num
    if (newQty < 0) return toast.error("Stock cannot go negative.")

    setLoading(true)
    try {
      await adminFetch(
        `/admin/inventory-items/${item.id}/location-levels/${selectedLevel.location_id}`,
        {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ stocked_quantity: newQty }),
        }
      )
      toast.success(`Stock updated to ${newQty} kg`)
      setValue("")
      onDone()
    } catch (e: any) {
      toast.error(e.message)
    } finally {
      setLoading(false)
    }
  }

  return (
    <div className="space-y-4 pt-4 border-t border-ui-border-base">
      <div className="flex gap-2">
        <Button size="small" variant={mode === "adjust" ? "primary" : "secondary"} onClick={() => setMode("adjust")}>Adjust (±)</Button>
        <Button size="small" variant={mode === "set" ? "primary" : "secondary"} onClick={() => setMode("set")}>Set total</Button>
      </div>
      {levels.length > 1 && (
        <div className="space-y-1">
          <Label>Location</Label>
          <select
            className="w-full border border-ui-border-base rounded px-2 py-1 text-sm"
            value={selectedLevel?.location_id ?? ""}
            onChange={e => setSelectedLevel(levels.find(l => l.location_id === e.target.value) ?? null)}
          >
            {levels.map(l => (
              <option key={l.location_id} value={l.location_id}>
                {l.location_id} — {l.stocked_quantity} kg
              </option>
            ))}
          </select>
        </div>
      )}
      <div className="space-y-1">
        <Label>{mode === "adjust" ? "Delta kg (+ to add, − to remove)" : "New total kg"}</Label>
        <Input
          type="number"
          placeholder={mode === "adjust" ? "e.g. 500 or -60" : "e.g. 1000"}
          value={value}
          onChange={e => setValue(e.target.value)}
        />
      </div>
      <Button onClick={submit} isLoading={loading}>Apply</Button>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Item detail panel
// ---------------------------------------------------------------------------

function ItemDetail({ itemId, onBack }: { itemId: string; onBack: () => void }) {
  const [item, setItem] = useState<InventoryItem | null>(null)

  const load = useCallback(async () => {
    const data = await adminFetch(
      `/admin/inventory-items/${itemId}?fields=id,title,sku,+metadata,+location_levels.stocked_quantity,+location_levels.reserved_quantity,+location_levels.available_quantity,+location_levels.location_id`
    )
    setItem(data.inventory_item)
  }, [itemId])

  useEffect(() => { load() }, [load])
  if (!item) return <Text>Loading…</Text>

  const totals = sumLevels(item.location_levels)

  return (
    <div className="space-y-6">
      <div className="flex items-center gap-3">
        <Button variant="secondary" size="small" onClick={onBack}>← Back</Button>
        <Heading level="h2">{item.metadata?.product_title ?? item.title}</Heading>
        <Text className="text-ui-fg-subtle text-sm">SKU: {item.sku}</Text>
      </div>

      <Container>
        <Heading level="h3" className="mb-4">Stock Summary</Heading>
        <div className="grid grid-cols-3 gap-4 text-center">
          {[
            { label: "Total (kg)", value: totals.stocked },
            { label: "Reserved (kg)", value: totals.reserved },
            { label: "Available (kg)", value: totals.available },
          ].map(({ label, value }) => (
            <div key={label} className="bg-ui-bg-subtle rounded p-4">
              <Text className="text-ui-fg-subtle text-sm mb-1">{label}</Text>
              <Text className="text-2xl font-semibold">{value.toLocaleString()}</Text>
            </div>
          ))}
        </div>
      </Container>

      <Container>
        <Heading level="h3" className="mb-2">Adjust Stock</Heading>
        <Text className="text-ui-fg-subtle text-sm mb-4">
          Medusa manages reserved kg automatically. Only adjust the physical stocked quantity here.
        </Text>
        <AdjustForm item={item} onDone={load} />
      </Container>

      {(item.location_levels?.length ?? 0) > 0 && (
        <Container>
          <Heading level="h3" className="mb-4">Stock by Location</Heading>
          <Table>
            <Table.Header>
              <Table.Row>
                <Table.HeaderCell>Location</Table.HeaderCell>
                <Table.HeaderCell>Stocked (kg)</Table.HeaderCell>
                <Table.HeaderCell>Reserved (kg)</Table.HeaderCell>
                <Table.HeaderCell>Available (kg)</Table.HeaderCell>
              </Table.Row>
            </Table.Header>
            <Table.Body>
              {item.location_levels!.map(l => (
                <Table.Row key={l.location_id}>
                  <Table.Cell className="font-mono text-xs">{l.location_id}</Table.Cell>
                  <Table.Cell>{l.stocked_quantity}</Table.Cell>
                  <Table.Cell>{l.reserved_quantity}</Table.Cell>
                  <Table.Cell>
                    <Badge color={l.available_quantity > 0 ? "green" : "red"}>
                      {l.available_quantity}
                    </Badge>
                  </Table.Cell>
                </Table.Row>
              ))}
            </Table.Body>
          </Table>
        </Container>
      )}
    </div>
  )
}

// ---------------------------------------------------------------------------
// Main page
// ---------------------------------------------------------------------------

export default function WeightStockPage() {
  const [items, setItems] = useState<InventoryItem[]>([])
  const [locations, setLocations] = useState<StockLocation[]>([])
  const [loading, setLoading] = useState(true)
  const [selected, setSelected] = useState<string | null>(null)
  const [showEnroll, setShowEnroll] = useState(false)

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const [itemsData, locData] = await Promise.all([
        adminFetch(
          `/admin/inventory-items?limit=100&fields=id,title,sku,+metadata,+location_levels.stocked_quantity,+location_levels.reserved_quantity,+location_levels.available_quantity`
        ),
        adminFetch(`/admin/stock-locations?limit=50&fields=id,name`),
      ])

      const weightItems = (itemsData.inventory_items ?? []).filter(
        (i: InventoryItem) => { const wb = i.metadata?.weight_based; return wb === true || wb === "true" }
      )
      setItems(weightItems)
      setLocations(locData.stock_locations ?? [])
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => { load() }, [load])

  if (selected) {
    return (
      <>
        <Toaster />
        <div className="p-6">
          <ItemDetail itemId={selected} onBack={() => { setSelected(null); load() }} />
        </div>
      </>
    )
  }

  return (
    <>
      <Toaster />

      {showEnroll && locations.length > 0 && (
        <EnrollModal
          locations={locations}
          onClose={() => setShowEnroll(false)}
          onDone={() => { setShowEnroll(false); load() }}
        />
      )}

      <div className="p-6 space-y-6">
        <div className="flex items-start justify-between">
          <div>
            <Heading>Weight Stock</Heading>
            <Text className="text-ui-fg-subtle">
              Bulk inventory — 1 unit = 1 kg. Medusa handles reservations and
              deductions automatically on orders.
            </Text>
          </div>
          <Button
            onClick={() => {
              if (locations.length === 0) {
                toast.error("No stock locations found. Create one in Settings → Locations first.")
                return
              }
              setShowEnroll(true)
            }}
          >
            + Enroll product
          </Button>
        </div>

        {loading ? (
          <Text>Loading…</Text>
        ) : items.length === 0 ? (
          <Container>
            <Text className="text-ui-fg-subtle">
              No weight-based products enrolled yet. Click{" "}
              <span className="font-medium">+ Enroll product</span> to get started.
            </Text>
          </Container>
        ) : (
          <Table>
            <Table.Header>
              <Table.Row>
                <Table.HeaderCell>Product</Table.HeaderCell>
                <Table.HeaderCell>SKU</Table.HeaderCell>
                <Table.HeaderCell>Total (kg)</Table.HeaderCell>
                <Table.HeaderCell>Reserved (kg)</Table.HeaderCell>
                <Table.HeaderCell>Available (kg)</Table.HeaderCell>
                <Table.HeaderCell>Status</Table.HeaderCell>
                <Table.HeaderCell />
              </Table.Row>
            </Table.Header>
            <Table.Body>
              {items.map(item => {
                const t = sumLevels(item.location_levels)
                const isLow = t.available < 100
                return (
                  <Table.Row key={item.id}>
                    <Table.Cell className="font-medium">
                      {item.metadata?.product_title ?? item.title}
                    </Table.Cell>
                    <Table.Cell className="font-mono text-xs text-ui-fg-subtle">{item.sku}</Table.Cell>
                    <Table.Cell>{t.stocked.toLocaleString()}</Table.Cell>
                    <Table.Cell>{t.reserved.toLocaleString()}</Table.Cell>
                    <Table.Cell>{t.available.toLocaleString()}</Table.Cell>
                    <Table.Cell>
                      <Badge color={isLow ? "orange" : "green"}>{isLow ? "Low" : "OK"}</Badge>
                    </Table.Cell>
                    <Table.Cell>
                      <Button variant="secondary" size="small" onClick={() => setSelected(item.id)}>
                        Manage
                      </Button>
                    </Table.Cell>
                  </Table.Row>
                )
              })}
            </Table.Body>
          </Table>
        )}
      </div>
    </>
  )
}

export const config = defineRouteConfig({
  label: "Weight Stock",
  icon: Package,
})
