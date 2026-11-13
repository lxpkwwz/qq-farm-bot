import type { RequestTicket } from '@/utils/request-guard'
import { defineStore } from 'pinia'
import { ref } from 'vue'
import api, { getApiErrorMessage } from '@/api'
import { createRequestGuard } from '@/utils/request-guard'

export interface CommerceItemDto {
  id: number
  count: number
  name: string
  image: string
  rarity: number
}

export interface PurchaseLimitDto {
  type: number
  bought: number
  max: number
  remaining: number | null
}

export interface MallGoodsDto {
  id: number
  name: string
  type: number
  rewards: CommerceItemDto[]
  price: CommerceItemDto & { balance: number | null }
  originalPrice?: number | null
  isFree: boolean
  limit: PurchaseLimitDto | null
  isLimited: boolean
  discountText: string
  isDiscounted: boolean
  discountEndTime: number
  available: boolean
  purchasable: boolean
  purchaseStatus?: 'available' | 'sold_out' | 'owned' | 'ad_required' | 'share_required' | 'svip_required' | 'unavailable'
  unavailableReason?: string
}

export interface MallCatalogDto {
  shopId?: number
  membership?: { isSvip: boolean, remainingDays: number } | null
  slotType: number
  subSlotType: number
  serverTime: number
  refreshCountdown: number
  currencies: Array<CommerceItemDto & { balanceKnown: boolean }>
  goods: MallGoodsDto[]
}

export interface MysteryShopDto {
  active: boolean
  serverTime: number
  activeTime?: number
  expireTime?: number
  npc: null | {
    id: number
    reward: CommerceItemDto
    price: CommerceItemDto & { balance: number | null }
    originalPrice: number
    unitPrice: number
    unitOriginalPrice: number
    discountPercent: number
  }
}

/** 老版购买历史字段形状：手动 / 自动购买共用一份记录。 */
export interface MysteryHistoryRecord {
  id: string
  purchasedAt: number
  source: 'auto' | 'manual'
  npcId: number
  itemId: number
  itemName: string
  itemImage: string
  itemCount: number
  currencyId: number
  currencyName: string
  price: number
  originalPrice: number
  discount: number
}

export const useCommerceStore = defineStore('commerce', () => {
  const mall = ref<MallCatalogDto | null>(null)
  const mystery = ref<MysteryShopDto | null>(null)
  const mysteryHistory = ref<MysteryHistoryRecord[]>([])
  const mallLoading = ref(false)
  const mysteryLoading = ref(false)
  const mysteryPurchasing = ref(false)
  const purchasingGoodsId = ref<number | null>(null)
  const error = ref('')
  const notice = ref('')
  const requestGuard = createRequestGuard({ accountId: () => localStorage.getItem('current_account_id') || '' })
  let mallAccountId = ''
  let mysteryAccountId = ''

  // 票号 + 当前账号一起校验：切号后旧账号的回包一律作废。
  function isCurrent(ticket: RequestTicket) {
    return !requestGuard.isStale(ticket)
  }

  function clearMessages() {
    error.value = ''
    notice.value = ''
  }

  function reset() {
    requestGuard.invalidate()
    mall.value = null
    mystery.value = null
    mysteryHistory.value = []
    mallAccountId = ''
    mysteryAccountId = ''
    mallLoading.value = false
    mysteryLoading.value = false
    purchasingGoodsId.value = null
    mysteryPurchasing.value = false
    clearMessages()
  }

  async function mergeDiamondBalance(accountId: string, catalog: MallCatalogDto) {
    const diamond = catalog.currencies.find(currency => currency.id === 1004)
    if (!diamond)
      return

    try {
      const response = await api.get('/api/diamond', {
        headers: { 'x-account-id': accountId },
        skipErrorToast: true,
      } as any)
      if (!response.data?.ok)
        return
      const balance = Number(response.data.data?.diamond)
      if (!Number.isFinite(balance) || balance < 0)
        return

      catalog.currencies = catalog.currencies.map(currency => currency.id === 1004
        ? { ...currency, count: balance, balanceKnown: true }
        : currency)
      catalog.goods = catalog.goods.map(goods => goods.price.id === 1004
        ? { ...goods, price: { ...goods.price, balance } }
        : goods)
    }
    catch {
      // Keep the catalog usable if the optional balance refresh is unavailable.
    }
  }

  async function fetchMall(accountId: string, slotType = 1, propsShop = false) {
    const id = String(accountId || '').trim()
    if (!id) {
      reset()
      return
    }
    const ticket = requestGuard.next(id)
    if (mallAccountId !== id || mall.value?.slotType !== slotType || !!mall.value?.shopId !== propsShop)
      mall.value = null
    mallAccountId = id
    mallLoading.value = true
    mysteryLoading.value = false
    clearMessages()
    try {
      const response = await api.get(propsShop ? '/api/props-shop' : '/api/game-mall', {
        headers: { 'x-account-id': id },
        params: propsShop ? undefined : { slotType, subSlotType: 1 },
        skipErrorToast: true,
      } as any)
      if (!isCurrent(ticket))
        return
      if (!response.data?.ok)
        throw new Error(getApiErrorMessage(response.data, '商城加载失败'))
      const catalog = response.data.data as MallCatalogDto
      await mergeDiamondBalance(id, catalog)
      if (!isCurrent(ticket))
        return
      mall.value = catalog
    }
    catch (cause: any) {
      if (!isCurrent(ticket))
        return
      error.value = getApiErrorMessage(cause, '商城加载失败')
    }
    finally {
      if (isCurrent(ticket))
        mallLoading.value = false
    }
  }

  async function purchaseMall(accountId: string, goods: MallGoodsDto, count: number) {
    const id = String(accountId || '').trim()
    if (!id || purchasingGoodsId.value !== null)
      return false
    const slotType = mall.value?.slotType || 1
    const propsShop = mall.value?.shopId === 4
    const ticket = requestGuard.snapshot(id)
    purchasingGoodsId.value = goods.id
    clearMessages()
    try {
      const response = await api.post(propsShop ? '/api/props-shop/purchase' : '/api/game-mall/purchase', {
        goodsId: goods.id,
        expectedPrice: { id: goods.price.id, count: goods.price.count, rewards: goods.rewards.map(item => ({ id: item.id, count: item.count })) },
        ...(propsShop ? { expectedOffer: { price: { id: goods.price.id, count: goods.price.count }, rewards: goods.rewards.map(item => ({ id: item.id, count: item.count })) } } : {}),
        slotType,
        count,
      }, {
        headers: { 'x-account-id': id },
        skipErrorToast: true,
      } as any)
      if (!response.data?.ok)
        throw new Error(getApiErrorMessage(response.data, '购买失败'))
      if (String(localStorage.getItem('current_account_id') || '') !== id)
        return false
      const catalog = response.data.data.catalog as MallCatalogDto | null
      if (catalog)
        await mergeDiamondBalance(id, catalog)
      if (String(localStorage.getItem('current_account_id') || '') !== id)
        return false
      if (!requestGuard.isStale(ticket))
        mall.value = catalog
      const rewards = (response.data.data.purchase?.rewards || [])
        .map((item: CommerceItemDto) => `${item.name} x${item.count}`)
        .join('、')
      notice.value = (rewards ? `购买成功：${rewards}` : '购买成功') + (!catalog ? '；请刷新商城确认最新状态' : '')
      return true
    }
    catch (cause: any) {
      if (String(localStorage.getItem('current_account_id') || '') === id)
        error.value = getApiErrorMessage(cause, '购买失败')
      return false
    }
    finally {
      purchasingGoodsId.value = null
    }
  }

  async function fetchMystery(accountId: string) {
    const id = String(accountId || '').trim()
    if (!id) {
      reset()
      return
    }
    const ticket = requestGuard.next(id)
    if (mysteryAccountId !== id)
      mystery.value = null
    mysteryAccountId = id
    mysteryLoading.value = true
    mallLoading.value = false
    clearMessages()
    try {
      const response = await api.get('/api/mystery-shop', {
        headers: { 'x-account-id': id },
        skipErrorToast: true,
      } as any)
      if (!isCurrent(ticket))
        return
      if (!response.data?.ok)
        throw new Error(getApiErrorMessage(response.data, '神秘商人加载失败'))
      mystery.value = response.data.data
    }
    catch (cause: any) {
      if (!isCurrent(ticket))
        return
      error.value = getApiErrorMessage(cause, '神秘商人加载失败')
    }
    finally {
      if (isCurrent(ticket))
        mysteryLoading.value = false
    }
  }

  /** 老版 /api/shop/mystery/history：按账号读取购买历史，读取失败不影响货品展示。 */
  async function fetchMysteryHistory(accountId: string) {
    const id = String(accountId || '').trim()
    if (!id) {
      mysteryHistory.value = []
      return
    }
    try {
      const response = await api.get('/api/mystery-shop/history', {
        headers: { 'x-account-id': id },
        skipErrorToast: true,
      } as any)
      if (!response.data?.ok || String(localStorage.getItem('current_account_id') || '') !== id)
        return
      const records = response.data.data
      mysteryHistory.value = Array.isArray(records) ? records : []
    }
    catch {
      // 记录读取失败不阻塞当前货品展示。
    }
  }

  async function purchaseMystery(accountId: string, npcId: number) {
    const id = String(accountId || '').trim()
    if (!id || mysteryPurchasing.value)
      return false
    mysteryPurchasing.value = true
    clearMessages()
    try {
      const response = await api.post('/api/mystery-shop/purchase', { npcId }, {
        headers: { 'x-account-id': id },
        skipErrorToast: true,
      } as any)
      if (!response.data?.ok)
        throw new Error(getApiErrorMessage(response.data, '购买失败'))
      if (String(localStorage.getItem('current_account_id') || '') !== id)
        return false
      mystery.value = response.data.data.shop
      void fetchMysteryHistory(id)
      const purchase = response.data.data.purchase as { reward?: CommerceItemDto, price?: CommerceItemDto } | undefined
      const reward = purchase?.reward
      const price = purchase?.price
      if (reward && price)
        notice.value = `购买成功：获得 ${reward.name} x${reward.count}，花费 ${price.count.toLocaleString()} ${price.name}`
      else if (reward)
        notice.value = `购买成功：获得 ${reward.name} x${reward.count}`
      else
        notice.value = '购买成功'
      return true
    }
    catch (cause: any) {
      if (String(localStorage.getItem('current_account_id') || '') === id)
        error.value = getApiErrorMessage(cause, '购买失败')
      return false
    }
    finally {
      mysteryPurchasing.value = false
    }
  }

  return {
    mall,
    mystery,
    mysteryHistory,
    mallLoading,
    mysteryLoading,
    mysteryPurchasing,
    purchasingGoodsId,
    error,
    notice,
    reset,
    clearMessages,
    fetchMall,
    purchaseMall,
    fetchMystery,
    fetchMysteryHistory,
    purchaseMystery,
  }
})
