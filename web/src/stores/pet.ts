import { defineStore } from 'pinia'
import { computed, ref } from 'vue'
import api, { getApiErrorMessage } from '@/api'
import { createRequestGuard } from '@/utils/request-guard'

export interface PetInfo {
  id: number
  name: string
  image: string
  rarity: number
  rarityLabel: string
  skills: PetSkillInfo[]
  skillDescription: string
  obtainCondition: string
  price: number
  level: number
  status: number
  owned: boolean
  activatable: boolean
  active: boolean
}

export interface PetSkillInfo {
  skillId?: number
  name: string
  description: string
  triggerRate?: number
  dailyLimit?: number
  usedCount?: number
  remainingCount?: number
  source: 'game-config' | 'client-static'
}

export interface DogFoodInfo {
  id: number
  name: string
  image: string
  duration: number
  count: number
}

export interface PetSnapshot {
  dogs: PetInfo[]
  foods: DogFoodInfo[]
  protectDuration: number
  maxProtectDuration: number
  remainingDuration: number
  pendingGiftCount: number
  activeDogId: number
  activeControlSupported: boolean
  guardianRecordsSupported: boolean
  skillCatalog: {
    source: 'client-static'
    requestVerified: boolean
    requestMethod: null
    skillsByPetId: Record<number, PetSkillInfo[]>
  }
}

export interface PetProtectLog {
  id: string
  friendGid: number
  friendName: string
  friendAvatar: string
  timestamp: number
  stolenCount: number
  protectedGold: number
  dogId: number
  dogName: string
}

/** 宠物资本模式：按作物成熟时间自动派出守护宠物，收获后自动召回。 */
export interface CapitalMode {
  enabled: boolean
  dogId: number
  leadSeconds: number
}

export const usePetStore = defineStore('pet', () => {
  const snapshot = ref<PetSnapshot | null>(null)
  const loading = ref(false)
  const usingFood = ref(false)
  const operatingDogId = ref(0)
  const protectLogs = ref<PetProtectLog[]>([])
  const protectLogsTotal = ref(0)
  const protectLogsLoading = ref(false)
  const capitalMode = ref<CapitalMode>({ enabled: false, dogId: 0, leadSeconds: 10 })
  const claimingGifts = ref(false)
  const giftError = ref('')
  const error = ref('')
  const accountId = ref('')
  const petGuard = createRequestGuard()
  const giftGuard = createRequestGuard()

  const dogs = computed(() => snapshot.value?.dogs || [])
  const foods = computed(() => snapshot.value?.foods || [])
  const activeDog = computed(() => dogs.value.find(dog => dog.active) || null)

  function clear() {
    petGuard.invalidate()
    giftGuard.invalidate()
    snapshot.value = null
    loading.value = false
    usingFood.value = false
    operatingDogId.value = 0
    protectLogs.value = []
    protectLogsTotal.value = 0
    protectLogsLoading.value = false
    capitalMode.value = { enabled: false, dogId: 0, leadSeconds: 10 }
    claimingGifts.value = false
    giftError.value = ''
    error.value = ''
    accountId.value = ''
  }

  async function fetchProtectLogs(requestedAccountId: string) {
    const id = String(requestedAccountId || '').trim()
    if (!id || protectLogsLoading.value)
      return false
    protectLogsLoading.value = true
    error.value = ''
    try {
      const res = await api.get('/api/pets/protect-logs', {
        headers: { 'x-account-id': id },
        skipErrorToast: true,
      } as any)
      if (!res.data?.ok) {
        error.value = getApiErrorMessage(res.data, '获取守护记录失败')
        return false
      }
      if (accountId.value === id) {
        protectLogs.value = (res.data.data?.logs || []) as PetProtectLog[]
        protectLogsTotal.value = Number(res.data.data?.total || protectLogs.value.length)
      }
      return true
    }
    catch (cause: any) {
      error.value = getApiErrorMessage(cause, '获取守护记录失败')
      return false
    }
    finally {
      protectLogsLoading.value = false
    }
  }

  async function fetchCapitalMode(requestedAccountId: string) {
    const id = String(requestedAccountId || '').trim()
    if (!id)
      return false
    try {
      const res = await api.get('/api/dog/capital-mode', {
        headers: { 'x-account-id': id },
        skipErrorToast: true,
      } as any)
      if (res.data?.ok && accountId.value === id)
        capitalMode.value = res.data.data as CapitalMode
      return !!res.data?.ok
    }
    catch {
      return false
    }
  }

  async function saveCapitalMode(requestedAccountId: string, config: CapitalMode) {
    const id = String(requestedAccountId || '').trim()
    if (!id)
      throw new Error('缺少账号')
    const res = await api.post('/api/dog/capital-mode', config, {
      headers: { 'x-account-id': id },
      skipErrorToast: true,
    } as any)
    if (!res.data?.ok)
      throw new Error(getApiErrorMessage(res.data, '保存失败'))
    if (accountId.value === id && res.data?.data?.capitalMode)
      capitalMode.value = res.data.data.capitalMode as CapitalMode
    return res.data.data
  }

  async function fetchPetInfo(requestedAccountId: string) {
    const id = String(requestedAccountId || '').trim()
    if (!id)
      return false

    const ticket = petGuard.next()
    accountId.value = id
    loading.value = true
    giftError.value = ''
    error.value = ''
    try {
      const res = await api.get('/api/pets', {
        headers: { 'x-account-id': id },
        skipErrorToast: true,
      } as any)
      if (petGuard.isStale(ticket) || accountId.value !== id)
        return false
      if (!res.data?.ok) {
        error.value = getApiErrorMessage(res.data, '无法读取宠物信息')
        return false
      }
      snapshot.value = res.data.data as PetSnapshot
      return true
    }
    catch (cause: any) {
      if (petGuard.isStale(ticket) || accountId.value !== id)
        return false
      error.value = getApiErrorMessage(cause, '无法读取宠物信息')
      return false
    }
    finally {
      if (!petGuard.isStale(ticket) && accountId.value === id)
        loading.value = false
    }
  }

  async function claimDogSkillGifts(requestedAccountId: string) {
    const id = String(requestedAccountId || '').trim()
    if (!id || claimingGifts.value)
      return null

    const ticket = giftGuard.next()
    claimingGifts.value = true
    giftError.value = ''
    try {
      const res = await api.post('/api/dog/skill-gifts/claim', {}, {
        headers: { 'x-account-id': id },
        skipErrorToast: true,
      } as any)
      if (!res.data?.ok || res.data?.data?.error) {
        if (!giftGuard.isStale(ticket) && accountId.value === id)
          giftError.value = getApiErrorMessage(res.data?.data?.error ? res.data.data : res.data, '拾取礼包失败')
        return null
      }

      const data = res.data.data || {}
      if (giftGuard.isStale(ticket) || accountId.value !== id)
        return null
      if (snapshot.value) {
        snapshot.value = {
          ...snapshot.value,
          pendingGiftCount: Math.max(0, Number(data.pending || 0)),
        }
      }
      return data
    }
    catch (cause: any) {
      if (!giftGuard.isStale(ticket) && accountId.value === id)
        giftError.value = getApiErrorMessage(cause, '拾取礼包失败')
      return null
    }
    finally {
      if (!giftGuard.isStale(ticket))
        claimingGifts.value = false
    }
  }

  async function useDogFood(requestedAccountId: string, itemId: number, count = 1, uid = 0) {
    const id = String(requestedAccountId || '').trim()
    if (!id || usingFood.value)
      return null

    usingFood.value = true
    error.value = ''
    try {
      const res = await api.post('/api/pets/food/use', { itemId, count, uid }, {
        headers: { 'x-account-id': id },
        skipErrorToast: true,
      } as any)
      if (!res.data?.ok) {
        error.value = getApiErrorMessage(res.data, '使用狗粮失败')
        return null
      }
      if (accountId.value === id && res.data?.data)
        snapshot.value = res.data.data as PetSnapshot
      return res.data.data
    }
    catch (cause: any) {
      error.value = getApiErrorMessage(cause, '使用狗粮失败')
      return null
    }
    finally {
      usingFood.value = false
    }
  }

  async function activateDog(requestedAccountId: string, dogId: number) {
    const id = String(requestedAccountId || '').trim()
    if (!id || operatingDogId.value)
      return null
    operatingDogId.value = dogId
    error.value = ''
    try {
      const res = await api.post('/api/pets/activate', { dogId }, { headers: { 'x-account-id': id }, skipErrorToast: true } as any)
      if (!res.data?.ok) {
        error.value = getApiErrorMessage(res.data, '宠物激活失败')
        return null
      }
      if (accountId.value === id)
        snapshot.value = res.data.data as PetSnapshot
      return res.data.data
    }
    catch (cause: any) {
      error.value = getApiErrorMessage(cause, '宠物激活失败')
      return null
    }
    finally {
      operatingDogId.value = 0
    }
  }

  async function deployDog(requestedAccountId: string, dogId: number) {
    const id = String(requestedAccountId || '').trim()
    if (!id || operatingDogId.value)
      return null
    operatingDogId.value = dogId
    error.value = ''
    try {
      const res = await api.post('/api/pets/deploy', { dogId }, { headers: { 'x-account-id': id }, skipErrorToast: true } as any)
      if (!res.data?.ok) {
        error.value = getApiErrorMessage(res.data, '宠物上场失败')
        return null
      }
      if (accountId.value === id)
        snapshot.value = res.data.data as PetSnapshot
      return res.data.data
    }
    catch (cause: any) {
      error.value = getApiErrorMessage(cause, '宠物上场失败')
      return null
    }
    finally {
      operatingDogId.value = 0
    }
  }

  async function withdrawDog(requestedAccountId: string, dogId: number) {
    const id = String(requestedAccountId || '').trim()
    if (!id || operatingDogId.value)
      return null
    operatingDogId.value = dogId
    error.value = ''
    try {
      const res = await api.post('/api/pets/withdraw', {}, { headers: { 'x-account-id': id }, skipErrorToast: true } as any)
      if (!res.data?.ok) {
        error.value = getApiErrorMessage(res.data, '宠物收回失败')
        return null
      }
      if (accountId.value === id)
        snapshot.value = res.data.data as PetSnapshot
      return res.data.data
    }
    catch (cause: any) {
      error.value = getApiErrorMessage(cause, '宠物收回失败')
      return null
    }
    finally {
      operatingDogId.value = 0
    }
  }

  return {
    snapshot,
    dogs,
    foods,
    activeDog,
    loading,
    usingFood,
    operatingDogId,
    protectLogs,
    protectLogsTotal,
    protectLogsLoading,
    capitalMode,
    claimingGifts,
    giftError,
    error,
    accountId,
    fetchPetInfo,
    fetchProtectLogs,
    fetchCapitalMode,
    saveCapitalMode,
    claimDogSkillGifts,
    useDogFood,
    activateDog,
    deployDog,
    withdrawDog,
    clear,
  }
})
