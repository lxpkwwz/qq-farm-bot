import type { Socket } from 'socket.io-client'
import { useStorage } from '@vueuse/core'
import { defineStore } from 'pinia'
import { io } from 'socket.io-client'
import { computed, ref } from 'vue'
import api, { getApiErrorMessage } from '@/api'
import { useAccountStore } from '@/stores/account'
import { createRequestGuard } from '@/utils/request-guard'

// Define interfaces for better type checking
interface DailyGift {
  key: string
  label: string
  enabled?: boolean
  doneToday: boolean
  lastAt?: number
  completedCount?: number
  totalCount?: number
  tasks?: any[]
  currentTask?: any | null
  mode?: 'check_only' | 'auto_claim'
  checkedToday?: boolean
  checkStatus?: 'unchecked' | 'entry_available' | 'entry_unavailable' | 'already_claimed' | 'check_failed'
  canShare?: boolean | null
  isVip?: boolean | null
  hasGift?: boolean | null
  canClaim?: boolean | null
  result?: string
  lastError?: string
  scheduledHour?: number
}

interface DailyGiftsResponse {
  date: string
  timeZone?: string
  growth: DailyGift
  gifts: DailyGift[]
}

export const useStatusStore = defineStore('status', () => {
  const accountStore = useAccountStore()
  const status = ref<any>(null)
  const logs = ref<any[]>([])
  const dailyGifts = ref<DailyGiftsResponse | null>(null)
  const dailyGiftsLoading = ref(false)
  const dailyGiftsError = ref('')
  const dailyGiftsGuard = createRequestGuard()
  const diamondBalance = ref(0)
  const loading = ref(false)
  const error = ref('')
  const realtimeConnected = ref(false)
  const realtimeLogsEnabled = ref(true)
  const currentRealtimeAccountId = ref('')
  const tokenRef = useStorage('admin_token', '')

  const currentAccountConnected = computed(() => {
    const accountId = String(accountStore.currentAccountId || '')
    return !!accountId
      && String(status.value?.accountId || '') === accountId
      && !!status.value?.connection?.connected
  })

  let socket: Socket | null = null
  const statusGuard = createRequestGuard()
  const diamondGuard = createRequestGuard()
  const logsGuard = createRequestGuard()
  // 已订阅的账号房间：同一账号不重复 subscribe，
  // 服务端每次 subscribe 都会全量重推 status + logs 快照，重复订阅会让前端数据周期性整体重建。
  let lastSubscribedAccount: string | null = null

  function normalizeStatusPayload(input: any) {
    return (input && typeof input === 'object') ? { ...input } : {}
  }

  function normalizeLogEntry(input: any) {
    const entry = (input && typeof input === 'object') ? { ...input } : {}
    const ts = Number(entry.ts) || Date.parse(String(entry.time || '')) || Date.now()
    return {
      ...entry,
      ts,
      time: entry.time || new Date(ts).toISOString().replace('T', ' ').slice(0, 19),
    }
  }

  function pushRealtimeLog(entry: any) {
    const next = normalizeLogEntry(entry)
    logs.value.push(next)
    if (logs.value.length > 300)
      logs.value = logs.value.slice(-300)
  }

  /**
   * 实时推送的账号归属。status 分支早已有守卫，logs 分支原来漏了：
   * 服务端 logs:snapshot 会带 accountId（未选账号时是 'all'），切号瞬间的旧快照
   * 会把上一个账号的日志整段灌进新账号视图。
   */
  function isRealtimeAccount(body: any): boolean {
    const incoming = String(body?.accountId || '')
    if (!incoming)
      return true
    const current = currentRealtimeAccountId.value
    if (incoming === 'all')
      return !current
    return !current || incoming === current
  }

  function handleRealtimeStatus(payload: any) {
    const body = (payload && typeof payload === 'object') ? payload : {}
    const accountId = String(body.accountId || '')
    if (currentRealtimeAccountId.value && accountId !== currentRealtimeAccountId.value)
      return
    if (body.status && typeof body.status === 'object') {
      const next = normalizeStatusPayload(body.status)
      // worker 每 10s 全量推一次 status；内容没变就不替换对象，
      // 否则所有页面依赖 status 的整棵组件树都会无谓重渲染，看起来像在不停刷新。
      if (status.value && JSON.stringify(next) === JSON.stringify(status.value)) {
        loading.value = false
        error.value = ''
        return
      }
      statusGuard.invalidate()
      loading.value = false
      status.value = next
      error.value = ''
    }
  }

  function handleRealtimeLog(payload: any) {
    if (!realtimeLogsEnabled.value)
      return
    const body = (payload && typeof payload === 'object') ? payload : {}
    if (!isRealtimeAccount(body))
      return
    pushRealtimeLog(payload)
  }

  function handleRealtimeLogsSnapshot(payload: any) {
    const body = (payload && typeof payload === 'object') ? payload : {}
    if (!isRealtimeAccount(body))
      return
    const list = Array.isArray(body.logs) ? body.logs : []
    logs.value = list.map((item: any) => normalizeLogEntry(item))
  }

  function ensureRealtimeSocket() {
    if (socket)
      return socket

    socket = io('/', {
      path: '/socket.io',
      autoConnect: false,
      transports: ['websocket'],
      auth: {
        token: tokenRef.value,
      },
    })

    socket.on('connect', () => {
      realtimeConnected.value = true
      lastSubscribedAccount = currentRealtimeAccountId.value || 'all'
      socket?.emit('subscribe', { accountId: lastSubscribedAccount })
    })

    socket.on('disconnect', () => {
      realtimeConnected.value = false
      lastSubscribedAccount = null
    })

    socket.on('connect_error', (err) => {
      realtimeConnected.value = false
      lastSubscribedAccount = null
      console.error('[realtime] 连接失败:', err.message)
    })

    socket.on('status:update', handleRealtimeStatus)
    socket.on('log:new', handleRealtimeLog)
    socket.on('logs:snapshot', handleRealtimeLogsSnapshot)
    return socket
  }

  function connectRealtime(accountId: string) {
    const nextAccountId = String(accountId || '').trim()
    const accountChanged = nextAccountId !== currentRealtimeAccountId.value
    currentRealtimeAccountId.value = nextAccountId
    if (accountChanged) {
      statusGuard.invalidate()
      logsGuard.invalidate()
      status.value = null
      logs.value = []
      loading.value = false
      error.value = ''
    }
    if (!tokenRef.value)
      return

    if (nextAccountId && (accountChanged || (!status.value && !loading.value)))
      void fetchStatus(nextAccountId)

    const client = ensureRealtimeSocket()
    client.auth = {
      token: tokenRef.value,
      accountId: currentRealtimeAccountId.value || 'all',
    }

    if (client.connected) {
      const target = currentRealtimeAccountId.value || 'all'
      if (lastSubscribedAccount !== target) {
        lastSubscribedAccount = target
        client.emit('subscribe', { accountId: target })
      }
      return
    }
    lastSubscribedAccount = null
    client.connect()
  }

  function disconnectRealtime() {
    if (!socket)
      return
    socket.off('connect')
    socket.off('disconnect')
    socket.off('connect_error')
    socket.off('status:update', handleRealtimeStatus)
    socket.off('log:new', handleRealtimeLog)
    socket.off('logs:snapshot', handleRealtimeLogsSnapshot)
    socket.disconnect()
    socket = null
    lastSubscribedAccount = null
    realtimeConnected.value = false
  }

  async function fetchStatus(accountId: string) {
    if (!accountId)
      return
    const ticket = statusGuard.next()
    loading.value = true
    try {
      const { data } = await api.get('/api/status', {
        headers: { 'x-account-id': accountId },
      })
      if (statusGuard.isStale(ticket))
        return
      if (data.ok) {
        status.value = normalizeStatusPayload(data.data)
        error.value = ''
      }
      else {
        error.value = getApiErrorMessage(data, '获取状态失败')
      }
    }
    catch (e: any) {
      if (!statusGuard.isStale(ticket))
        error.value = getApiErrorMessage(e, '获取状态失败')
    }
    finally {
      if (!statusGuard.isStale(ticket))
        loading.value = false
    }
  }

  async function fetchLogs(accountId: string, options: any = {}) {
    if (!accountId && options.accountId !== 'all')
      return
    const params: any = { limit: 100, ...options }
    const headers: any = {}
    if (accountId && accountId !== 'all') {
      headers['x-account-id'] = accountId
    }
    else {
      params.accountId = 'all'
    }

    // Dashboard 每 10s 轮询，切号 watch 也会立刻拉一次；没有序号守卫时
    // 旧账号晚到的响应会直接覆盖新账号的 logs，实时推送还会继续往里追加。
    const ticket = logsGuard.next()
    try {
      const { data } = await api.get('/api/logs', { headers, params })
      if (logsGuard.isStale(ticket))
        return
      if (data.ok) {
        logs.value = data.data
        error.value = ''
      }
    }
    catch (e: any) {
      console.error(e)
    }
  }

  async function fetchDiamond(accountId: string) {
    const id = String(accountId || '').trim()
    if (!id)
      return
    const ticket = diamondGuard.next()
    diamondBalance.value = 0

    try {
      const { data } = await api.get('/api/diamond', {
        headers: { 'x-account-id': id },
        skipErrorToast: true,
      } as any)
      if (data.ok && !diamondGuard.isStale(ticket))
        diamondBalance.value = Math.max(0, Number(data.data?.diamond) || 0)
    }
    catch {
      // Supplementary balance data should not disrupt the dashboard.
    }
  }

  async function fetchDailyGifts(accountId: string) {
    if (!accountId)
      return
    const ticket = dailyGiftsGuard.next()
    dailyGiftsLoading.value = true
    dailyGiftsError.value = ''
    try {
      const { data } = await api.get('/api/daily-gifts', {
        headers: { 'x-account-id': accountId },
      })
      if (dailyGiftsGuard.isStale(ticket))
        return
      if (data.ok) {
        dailyGifts.value = data.data
      }
      else {
        dailyGiftsError.value = getApiErrorMessage(data, '获取每日奖励失败')
      }
    }
    catch (e) {
      if (!dailyGiftsGuard.isStale(ticket))
        dailyGiftsError.value = getApiErrorMessage(e, '获取每日奖励失败')
    }
    finally {
      if (!dailyGiftsGuard.isStale(ticket))
        dailyGiftsLoading.value = false
    }
  }

  function setRealtimeLogsEnabled(enabled: boolean) {
    realtimeLogsEnabled.value = !!enabled
  }

  return {
    status,
    logs,
    dailyGifts,
    dailyGiftsLoading,
    dailyGiftsError,
    diamondBalance,
    loading,
    error,
    realtimeConnected,
    currentAccountConnected,
    realtimeLogsEnabled,
    fetchStatus,
    fetchDiamond,
    fetchLogs,
    fetchDailyGifts,
    setRealtimeLogsEnabled,
    connectRealtime,
    disconnectRealtime,
  }
})
