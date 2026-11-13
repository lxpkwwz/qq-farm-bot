import type { Ref } from 'vue'
import { computed, ref, watch } from 'vue'
import api, { getApiErrorMessage } from '@/api'
import { useStatusStore } from '@/stores/status'
import { createRequestGuard } from '@/utils/request-guard'

/**
 * 种植策略的可视数据源：可售种子（优先种子下拉与预览）、背包种子（优先顺序与土地限制）。
 * 设置页里这些数据原来散在页面顶部，现在被「种植与收获」弹窗和首页摘要共用，集中到这里。
 */
interface SeedOptionItem {
  seedId: number
  name: string
  requiredLevel: number
  price: number
  locked?: boolean
  soldOut?: boolean
}

interface BagSeedItem {
  seedId: number
  name: string
  count: number
  requiredLevel: number
  plantSize: number
  image?: string
}

// 老版方案（useStrategySettings 直接读共享的 farmStore.seeds）：
// “种植与收获”弹窗每次打开都会重建组件，这里用模块级缓存按账号回填，
// 预览与背包种子列表秒出，后台仍会静默刷新最新数据。
const seedOptionsCache = new Map<string, SeedOptionItem[]>()
const bagSeedsCache = new Map<string, BagSeedItem[]>()
// 分析排行（第二优先策略预览用）的短 TTL 缓存：重开弹窗不再等一次 /api/analytics 往返。
const analyticsRankingsCache = new Map<string, { at: number, rankings: any[] }>()
const ANALYTICS_CACHE_TTL_MS = 60 * 1000

export function usePlantingStrategy(options: {
  strategy: Ref<any>
  accountId: Ref<string | number | null | undefined>
  landTypeOptions: { label: string, value: string }[]
}) {
  const { strategy, accountId, landTypeOptions } = options
  const statusStore = useStatusStore()
  const runtimeStatus = computed(() => statusStore.status)

  const analyticsSortByMap: Record<string, string> = {
    max_exp: 'exp',
    max_fert_exp: 'fert',
    max_profit: 'profit',
    max_fert_profit: 'fert_profit',
  }

  const seedOptions = ref<SeedOptionItem[]>([])
  const seedOptionsRevision = ref(0)
  const bagSeeds = ref<BagSeedItem[]>([])
  const bagSeedsLoading = ref(false)
  const bagSeedsError = ref<string | null>(null)
  const draggingBagSeedId = ref<number | null>(null)
  const strategyPreviewLabel = ref<string | null>(null)

  // 四个请求都绑定账号：切号后旧账号的回包一律作废（原来每处都手写 `id !== currentAccountId()`）。
  const seedOptionsGuard = createRequestGuard({ accountId: () => currentAccountId() })
  const bagSeedsGuard = createRequestGuard({ accountId: () => currentAccountId() })
  const bagSortGuard = createRequestGuard({ accountId: () => currentAccountId() })
  const previewGuard = createRequestGuard({ accountId: () => currentAccountId() })
  let seedOptionsRequestAccountId = ''
  let seedOptionsLoadedAccountId = ''
  let bagSeedsRequestAccountId = ''
  let bagSeedsLoadedAccountId = ''

  const plantNameBySeedId = ref(new Map<number, string>())
  let plantConfigLoaded = false

  // 组件重建时先用缓存回填：预览不再从空白+“加载中”开始。
  const initialAccountId = currentAccountId()
  if (initialAccountId) {
    seedOptions.value = seedOptionsCache.get(initialAccountId) ?? []
    bagSeeds.value = bagSeedsCache.get(initialAccountId) ?? []
  }

  async function ensurePlantConfigLoaded() {
    if (plantConfigLoaded)
      return
    plantConfigLoaded = true
    try {
      const res = await api.get('/game-config/Plant.json', { skipErrorToast: true } as any)
      const plants = Array.isArray(res?.data) ? res.data : []
      plantNameBySeedId.value = new Map(
        plants
          .map((plant: any): [number, string] => [Number(plant?.seed_id) || 0, String(plant?.name || '').trim()])
          .filter(([seedId, name]) => seedId > 0 && !!name),
      )
    }
    catch {
      // 静态配置加载失败时保持按种子 ID 显示
    }
  }

  function currentAccountId() {
    return String(accountId.value ?? '')
  }

  function isAccountConnected(id: string) {
    return String(runtimeStatus.value?.accountId || '') === String(id)
      && runtimeStatus.value?.connection?.connected === true
  }

  async function fetchSeedOptions(id: string) {
    if (!id || !isAccountConnected(id) || seedOptionsRequestAccountId === id || seedOptionsLoadedAccountId === id)
      return
    const ticket = seedOptionsGuard.next(id)
    seedOptionsRequestAccountId = id
    try {
      const { data } = await api.get('/api/seeds', {
        headers: { 'x-account-id': id },
        skipErrorToast: true,
      } as any)
      if (seedOptionsGuard.isStale(ticket))
        return
      seedOptions.value = data?.ok ? (data.data || []) : []
      if (data?.ok)
        seedOptionsCache.set(id, seedOptions.value)
      seedOptionsRevision.value++
      if (id === currentAccountId())
        seedOptionsLoadedAccountId = id
    }
    catch {
      if (!seedOptionsGuard.isStale(ticket)) {
        seedOptions.value = []
        seedOptionsRevision.value++
        seedOptionsLoadedAccountId = id
      }
    }
    finally {
      if (seedOptionsRequestAccountId === id)
        seedOptionsRequestAccountId = ''
    }
  }

  async function fetchBagSeeds(id = currentAccountId()) {
    if (!id || !isAccountConnected(id) || bagSeedsRequestAccountId === id || bagSeedsLoadedAccountId === id)
      return
    const ticket = bagSeedsGuard.next(id)
    bagSeedsRequestAccountId = id
    bagSeedsLoading.value = true
    bagSeedsError.value = null
    // 内部已捕获异常并写入加载状态，这里按设计不等待。
    void ensurePlantConfigLoaded()
    try {
      const res = await api.get('/api/bag/seeds', {
        headers: { 'x-account-id': id },
        skipErrorToast: true,
      } as any)
      if (bagSeedsGuard.isStale(ticket))
        return
      if (res.data.ok) {
        bagSeeds.value = (res.data.data || []).filter((seed: BagSeedItem) => seed.plantSize >= 1)
        bagSeedsCache.set(id, bagSeeds.value)
      }
      else {
        bagSeeds.value = []
        bagSeedsError.value = getApiErrorMessage(res.data, '加载失败')
        bagSeedsLoadedAccountId = id
      }
      if (id === currentAccountId())
        bagSeedsLoadedAccountId = id
    }
    catch (e: any) {
      e.message = getApiErrorMessage(e, '加载失败')
      if (!bagSeedsGuard.isStale(ticket)) {
        bagSeedsError.value = e.message || '加载失败'
        bagSeedsLoadedAccountId = id
      }
    }
    finally {
      if (!bagSeedsGuard.isStale(ticket))
        bagSeedsLoading.value = false
      if (bagSeedsRequestAccountId === id)
        bagSeedsRequestAccountId = ''
    }
  }

  const visibleBagSeedIds = computed(() => bagSeeds.value.map(seed => seed.seedId))

  function normalizeVisibleBagSeedOrder(priority: number[] = strategy.value.bagSeedPriority || []) {
    const visibleIds = visibleBagSeedIds.value
    const visibleSet = new Set(visibleIds)
    const normalized: number[] = []
    for (const seedId of priority || []) {
      const id = Number(seedId)
      if (visibleSet.has(id) && !normalized.includes(id))
        normalized.push(id)
    }
    for (const seedId of visibleIds) {
      if (!normalized.includes(seedId))
        normalized.push(seedId)
    }
    return normalized
  }

  function mergeVisibleBagSeedOrder(visibleOrder: number[]) {
    const visibleIds = visibleBagSeedIds.value
    const visibleSet = new Set(visibleIds)
    const normalizedVisible = normalizeVisibleBagSeedOrder(visibleOrder)
    const existing: number[] = [...new Set<number>(((strategy.value.bagSeedPriority || []) as unknown[])
      .map(Number)
      .filter((id: number) => Number.isFinite(id) && id > 0))]
    const merged: number[] = []
    let visibleIndex = 0

    for (const seedId of existing) {
      if (visibleSet.has(seedId)) {
        const replacement = normalizedVisible[visibleIndex++]
        if (replacement !== undefined && !merged.includes(replacement))
          merged.push(replacement)
      }
      else if (!merged.includes(seedId)) {
        // 暂时缺货的种子保留原有优先级位置，重新入库后仍按原顺序执行。
        merged.push(seedId)
      }
    }
    while (visibleIndex < normalizedVisible.length) {
      const seedId = normalizedVisible[visibleIndex++]!
      if (!merged.includes(seedId))
        merged.push(seedId)
    }
    return merged
  }

  const sortedBagSeeds = computed(() => {
    const itemMap = new Map(bagSeeds.value.map(seed => [seed.seedId, seed]))
    return normalizeVisibleBagSeedOrder()
      .map(seedId => itemMap.get(seedId))
      .filter((seed): seed is BagSeedItem => !!seed)
  })

  const orphanRestrictedSeeds = computed(() => {
    // 背包列表未加载时无法判断谁真的缺货，此时不显示，避免误清除已有限制。
    if (bagSeeds.value.length === 0)
      return []
    const visible = new Set(visibleBagSeedIds.value)
    const landTypes = strategy.value.bagSeedLandTypes || {}
    return Object.entries(landTypes)
      .map(([seedId, types]) => ({ seedId: Number(seedId), types: (types || []) as string[] }))
      .filter(item => item.seedId > 0 && item.types.length > 0 && !visible.has(item.seedId))
      .sort((a, b) => a.seedId - b.seedId)
      .map((item) => {
        const labels = landTypeOptions
          .filter(option => item.types.includes(option.value))
          .map(option => option.label)
        return {
          seedId: item.seedId,
          name: plantNameBySeedId.value.get(item.seedId) || `种子 #${item.seedId}`,
          scope: `仅种 ${labels.join('、')}`,
        }
      })
  })

  function setBagSeedLandTypes(seedId: number, types: string[]) {
    const next = { ...(strategy.value.bagSeedLandTypes || {}) }
    // 按固定顺序收敛；不勾或勾满都等价于不限制，直接去掉该 seedId。
    const normalized = landTypeOptions
      .map(option => option.value)
      .filter(value => types.includes(value))
    if (normalized.length === 0 || normalized.length === landTypeOptions.length)
      delete next[String(seedId)]
    else
      next[String(seedId)] = normalized
    strategy.value.bagSeedLandTypes = next
  }

  function materializeVisibleBagSeedOrder() {
    return normalizeVisibleBagSeedOrder()
  }

  function saveVisibleBagSeedOrder(visibleOrder: number[]) {
    bagSortGuard.invalidate()
    strategy.value.bagSeedPriority = mergeVisibleBagSeedOrder(visibleOrder)
  }

  function compareBagSeedsByLevel(a: BagSeedItem, b: BagSeedItem) {
    if (a.requiredLevel !== b.requiredLevel)
      return b.requiredLevel - a.requiredLevel
    return a.seedId - b.seedId
  }

  async function sortBagSeedsByFallbackStrategy(fallback: string, id = currentAccountId()) {
    if (!id || id !== currentAccountId())
      return
    const ticket = bagSortGuard.next(id)
    const strategyAtRequest = fallback
    const items = [...bagSeeds.value]
    const ordered = [...items].sort(compareBagSeedsByLevel)

    if (strategyAtRequest === 'preferred') {
      const preferredSeedId = Number(strategy.value.preferredSeedId || 0)
      ordered.sort((a, b) => {
        const aPreferred = a.seedId === preferredSeedId ? 0 : 1
        const bPreferred = b.seedId === preferredSeedId ? 0 : 1
        return aPreferred - bPreferred || compareBagSeedsByLevel(a, b)
      })
    }
    else if (strategyAtRequest !== 'level') {
      const sortBy = analyticsSortByMap[strategyAtRequest]
      if (sortBy) {
        try {
          const { data } = await api.get('/api/analytics', {
            params: { sort: sortBy },
            headers: { 'x-account-id': id },
          })
          if (bagSortGuard.isStale(ticket) || strategy.value.bagSeedFallbackStrategy !== strategyAtRequest)
            return
          const rankMap = new Map<number, number>()
          const rankings: any[] = data?.ok ? (data.data || []) : []
          rankings.forEach((item, index) => rankMap.set(Number(item.seedId), index))
          ordered.sort((a, b) => {
            const aRank = rankMap.get(a.seedId) ?? Number.MAX_SAFE_INTEGER
            const bRank = rankMap.get(b.seedId) ?? Number.MAX_SAFE_INTEGER
            return aRank - bRank || compareBagSeedsByLevel(a, b)
          })
        }
        catch {
          // 排名请求失败时保留稳定的等级/ID顺序。
        }
      }
    }

    if (bagSortGuard.isStale(ticket) || strategy.value.bagSeedFallbackStrategy !== strategyAtRequest)
      return
    saveVisibleBagSeedOrder(ordered.map(seed => seed.seedId))
  }

  async function ensureBagSeedsForUserSort(id: string) {
    if (bagSeedsLoading.value || bagSeeds.value.length === 0)
      await fetchBagSeeds(id)
  }

  async function handleBagFallbackStrategyChange(value: string | number) {
    const id = currentAccountId()
    const fallback = String(value)
    if (!id)
      return
    await ensureBagSeedsForUserSort(id)
    if (id === currentAccountId() && strategy.value.bagSeedFallbackStrategy === fallback)
      await sortBagSeedsByFallbackStrategy(fallback, id)
  }

  async function handlePreferredSeedChange() {
    const id = currentAccountId()
    if (!id || strategy.value.plantingStrategy !== 'bag_priority' || strategy.value.bagSeedFallbackStrategy !== 'preferred')
      return
    await ensureBagSeedsForUserSort(id)
    if (id === currentAccountId() && strategy.value.bagSeedFallbackStrategy === 'preferred')
      await sortBagSeedsByFallbackStrategy('preferred', id)
  }

  async function resetBagSeedPriority() {
    const id = currentAccountId()
    const fallback = strategy.value.bagSeedFallbackStrategy
    if (!id)
      return
    await ensureBagSeedsForUserSort(id)
    if (id === currentAccountId() && strategy.value.bagSeedFallbackStrategy === fallback)
      await sortBagSeedsByFallbackStrategy(fallback, id)
  }

  function moveBagSeed(seedId: number, direction: -1 | 1) {
    const nextOrder = materializeVisibleBagSeedOrder()
    const index = nextOrder.indexOf(seedId)
    const targetIndex = index + direction
    if (index < 0 || targetIndex < 0 || targetIndex >= nextOrder.length)
      return

    const temp = nextOrder[index]!
    nextOrder[index] = nextOrder[targetIndex]!
    nextOrder[targetIndex] = temp
    saveVisibleBagSeedOrder(nextOrder)
  }

  function moveBagSeedUp(seedId: number) {
    moveBagSeed(seedId, -1)
  }

  function moveBagSeedDown(seedId: number) {
    moveBagSeed(seedId, 1)
  }

  function startBagSeedDrag(seedId: number, event: DragEvent) {
    materializeVisibleBagSeedOrder()
    draggingBagSeedId.value = seedId
    if (event.dataTransfer) {
      event.dataTransfer.effectAllowed = 'move'
      event.dataTransfer.setData('text/plain', String(seedId))
    }
  }

  function endBagSeedDrag() {
    draggingBagSeedId.value = null
  }

  function dragOverBagSeed(_seedId: number, event: DragEvent) {
    if (draggingBagSeedId.value === null)
      return
    event.preventDefault()
    if (event.dataTransfer)
      event.dataTransfer.dropEffect = 'move'
  }

  function dropBagSeed(seedId: number, event: DragEvent) {
    event.preventDefault()
    const sourceSeedId = draggingBagSeedId.value ?? Number(event.dataTransfer?.getData('text/plain') || '')
    if (!sourceSeedId || sourceSeedId === seedId) {
      endBagSeedDrag()
      return
    }

    const nextOrder = materializeVisibleBagSeedOrder()
    const sourceIndex = nextOrder.indexOf(sourceSeedId)
    const targetIndex = nextOrder.indexOf(seedId)
    if (sourceIndex < 0 || targetIndex < 0) {
      endBagSeedDrag()
      return
    }

    const [source] = nextOrder.splice(sourceIndex, 1)
    const newTargetIndex = sourceIndex < targetIndex ? targetIndex - 1 : targetIndex
    nextOrder.splice(newTargetIndex, 0, source!)
    saveVisibleBagSeedOrder(nextOrder)
    endBagSeedDrag()
  }

  const preferredSeedOptions = computed(() => {
    const list: { label: string, value: number, disabled?: boolean }[] = [{ label: '自动选择', value: 0, disabled: false }]
    list.push(...seedOptions.value.map(seed => ({
      label: `${seed.requiredLevel}级 ${seed.name} (${seed.price}金)`,
      value: seed.seedId,
      disabled: seed.locked || seed.soldOut,
    })))
    return list
  })

  watch(() => [strategy.value.plantingStrategy, currentAccountId()] as const, ([planting, id], previous) => {
    if (planting === 'bag_priority' && id && isAccountConnected(id) && (previous?.[0] !== planting || previous?.[1] !== id))
      void fetchBagSeeds(id)
  }, { immediate: true })

  watch(() => [
    strategy.value.plantingStrategy,
    strategy.value.bagSeedFallbackStrategy,
    strategy.value.preferredSeedId,
    seedOptionsRevision.value,
    currentAccountId(),
  ] as const, async ([plantingStrategy, fallbackStrategy, preferredSeedId, , id]) => {
    const currentSeeds = seedOptions.value
    const ticket = previewGuard.next(id)
    let picked = plantingStrategy
    if (picked === 'preferred') {
      strategyPreviewLabel.value = null
      return
    }
    if (picked === 'bag_priority') {
      picked = fallbackStrategy || 'level'
      if (picked === 'preferred') {
        const seed = preferredSeedId > 0 ? currentSeeds.find(item => item.seedId === preferredSeedId) : undefined
        strategyPreviewLabel.value = seed ? `${seed.requiredLevel}级 ${seed.name}` : '未选择优先种子'
        return
      }
    }
    if (currentSeeds.length === 0) {
      strategyPreviewLabel.value = null
      return
    }
    const available = currentSeeds.filter(seed => !seed.locked && !seed.soldOut)
    if (available.length === 0) {
      strategyPreviewLabel.value = '暂无可用种子'
      return
    }
    if (picked === 'level') {
      const best = [...available].sort((a, b) => b.requiredLevel - a.requiredLevel || a.seedId - b.seedId)[0]
      strategyPreviewLabel.value = best ? `${best.requiredLevel}级 ${best.name}` : null
      return
    }
    const sortBy = analyticsSortByMap[picked]
    if (!sortBy)
      return

    const applyRankings = (rankings: any[]) => {
      const availableIds = new Set(available.map(seed => seed.seedId))
      const match = rankings.find(item => availableIds.has(Number(item.seedId)))
      const seed = match ? available.find(item => item.seedId === Number(match.seedId)) : undefined
      strategyPreviewLabel.value = seed ? `${seed.requiredLevel}级 ${seed.name}` : '暂无匹配种子'
    }

    // 短 TTL 缓存命中时先同步出结果（重开弹窗不再先闪“加载中”），请求回来后再静默校正。
    const cacheKey = `${id || 'all'}:${sortBy}`
    const cached = analyticsRankingsCache.get(cacheKey)
    const cacheFresh = !!cached && Date.now() - cached.at < ANALYTICS_CACHE_TTL_MS
    if (cacheFresh)
      applyRankings(cached!.rankings)

    try {
      const { data } = await api.get('/api/analytics', {
        params: { sort: sortBy },
        headers: id ? { 'x-account-id': id } : undefined,
      })
      if (previewGuard.isStale(ticket))
        return
      const rankings: any[] = data?.ok ? (data.data || []) : []
      analyticsRankingsCache.set(cacheKey, { at: Date.now(), rankings })
      applyRankings(rankings)
    }
    catch {
      if (!previewGuard.isStale(ticket) && !cacheFresh)
        strategyPreviewLabel.value = null
    }
  }, { immediate: true })

  watch(currentAccountId, () => {
    draggingBagSeedId.value = null
    bagSeedsError.value = null
    strategyPreviewLabel.value = null
    const id = currentAccountId()
    // 切账号时用缓存回填，避免列表先清空再加载的闪烁。
    seedOptions.value = (id && seedOptionsCache.get(id)) || []
    bagSeeds.value = (id && bagSeedsCache.get(id)) || []
    seedOptionsRequestAccountId = ''
    seedOptionsLoadedAccountId = ''
    bagSeedsRequestAccountId = ''
    bagSeedsLoadedAccountId = ''
    if (id)
      void fetchSeedOptions(id)
  })

  watch(() => [
    runtimeStatus.value?.accountId,
    runtimeStatus.value?.connection?.connected,
    currentAccountId(),
  ] as const, ([statusAccountId, connected, id]) => {
    if (!connected || !id || String(statusAccountId || '') !== String(id))
      return
    void fetchSeedOptions(id)
    if (strategy.value.plantingStrategy === 'bag_priority')
      void fetchBagSeeds(id)
  }, { immediate: true })

  function reset() {
    draggingBagSeedId.value = null
    bagSeedsError.value = null
    strategyPreviewLabel.value = null
    // 保留模块级缓存：reset 后仍可直接秒显上次数据，等待后台刷新。
    const id = currentAccountId()
    seedOptions.value = (id && seedOptionsCache.get(id)) || []
    bagSeeds.value = (id && bagSeedsCache.get(id)) || []
  }

  return {
    seedOptionsRevision,
    seedOptions,
    preferredSeedOptions,
    strategyPreviewLabel,
    bagSeeds,
    bagSeedsLoading,
    bagSeedsError,
    sortedBagSeeds,
    orphanRestrictedSeeds,
    draggingBagSeedId,
    setBagSeedLandTypes,
    handleBagFallbackStrategyChange,
    handlePreferredSeedChange,
    resetBagSeedPriority,
    moveBagSeedUp,
    moveBagSeedDown,
    startBagSeedDrag,
    endBagSeedDrag,
    dragOverBagSeed,
    dropBagSeed,
    normalizeVisibleBagSeedOrder,
    mergeVisibleBagSeedOrder,
    fetchBagSeeds,
    fetchSeedOptions,
    reset,
  }
}
