import { defineStore } from 'pinia'
import { computed, ref } from 'vue'
import api from '@/api'

export interface PanelNotificationDto {
  id: string
  createdAt: number
  dedupeKey: string
  type: string
  title: string
  content: string
}

const READ_KEY = 'panel_notifications_read_at'

function readAt(accountId: string): number {
  try {
    return Number(localStorage.getItem(`${READ_KEY}:${accountId}`)) || 0
  }
  catch {
    return 0
  }
}

/** 面板内消息（局内通知）：后端只读列表，未读状态按账号记在浏览器本地，避免多进程争抢同一个文件。 */
export const usePanelNotificationStore = defineStore('panel-notifications', () => {
  const items = ref<PanelNotificationDto[]>([])
  const accountId = ref('')
  const lastReadAt = ref(0)
  const loading = ref(false)
  /** 正在拉取的账号：按账号去重，切号时新账号不会被上一个账号的在途请求挡掉。 */
  const inflight = new Set<string>()

  const unreadCount = computed(() => items.value.filter(item => Number(item.createdAt) > lastReadAt.value).length)

  function currentAccountId(): string {
    return String(localStorage.getItem('current_account_id') || '').trim()
  }

  async function fetch(accountIdArg?: string) {
    const id = String(accountIdArg || currentAccountId() || '').trim()
    if (!id) {
      accountId.value = ''
      items.value = []
      return
    }
    if (accountId.value !== id) {
      // 切号瞬间必须先把上一个账号的消息清掉：否则在下一轮拉取成功之前，
      // 铃铛里显示的是别人的通知，未读数也是别人的。
      accountId.value = id
      items.value = []
      lastReadAt.value = readAt(id)
    }
    if (inflight.has(id))
      return
    inflight.add(id)
    loading.value = true
    try {
      const response = await api.get('/api/panel-notifications', {
        headers: { 'x-account-id': id },
        skipErrorToast: true,
      } as any)
      if (!response.data?.ok || accountId.value !== id)
        return
      const list = response.data.data
      items.value = Array.isArray(list) ? list : []
    }
    catch {
      // 通知是附加信息，读失败时保留上一批，不弹错误提示
    }
    finally {
      inflight.delete(id)
      loading.value = inflight.size > 0
    }
  }

  function markAllRead() {
    const id = accountId.value || currentAccountId()
    if (!id)
      return
    const now = Date.now()
    lastReadAt.value = now
    try {
      localStorage.setItem(`${READ_KEY}:${id}`, String(now))
    }
    catch {
      // 隐私模式下写不进去也不影响本次会话的未读状态
    }
  }

  return { items, accountId, unreadCount, fetch, markAllRead }
})
