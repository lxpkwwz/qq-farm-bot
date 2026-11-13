import { useIntervalFn } from '@vueuse/core'
import { storeToRefs } from 'pinia'
import { computed, effectScope, ref, watch } from 'vue'
import { useAccountStore } from '@/stores/account'

const AUTO_REFRESH_KEY = 'qq-farm-bot:farm-refresh'

/** 开关与秒数为模块级共享状态：土地 / 背包 / 任务三个面板用同一份，跟随当前账号读写 localStorage。 */
const autoRefreshEnabled = ref(false)
const autoRefreshSeconds = ref(60)
let initialized = false

function clampSeconds(value: number) {
  return Math.min(600, Math.max(10, Math.round(Number(value) || 60)))
}

function readForAccount(accountId: string) {
  try {
    const raw = JSON.parse(localStorage.getItem(`${AUTO_REFRESH_KEY}:${accountId}`) || '{}')
    autoRefreshEnabled.value = raw?.enabled === true
    autoRefreshSeconds.value = clampSeconds(Number(raw?.seconds))
  }
  catch {
    autoRefreshEnabled.value = false
    autoRefreshSeconds.value = 60
  }
}

/**
 * 偏好监听放在独立（detached）作用域：注册它的组件卸载（切路由 / 切页签）后 watch 仍然有效，
 * 否则切账号时不会重新读取该账号的开关，开关变化也不会再写回 localStorage。
 */
function ensurePreferenceWatchers() {
  if (initialized)
    return
  initialized = true
  effectScope(true).run(() => {
    const { currentAccountId } = storeToRefs(useAccountStore())
    watch(currentAccountId, accountId => readForAccount(String(accountId || '')), { immediate: true })
    watch([autoRefreshEnabled, autoRefreshSeconds], () => {
      const accountId = String(currentAccountId.value || '')
      if (!accountId)
        return
      try {
        localStorage.setItem(`${AUTO_REFRESH_KEY}:${accountId}`, JSON.stringify({
          enabled: autoRefreshEnabled.value,
          seconds: clampSeconds(autoRefreshSeconds.value),
        }))
      }
      catch {
        // 偏好存不下不影响使用
      }
    })
  })
}

/** 默认不自动刷新：只有显式开启后，各面板才按设定的秒数周期刷新。 */
export function useFarmAutoRefresh() {
  ensurePreferenceWatchers()
  const autoRefreshIntervalMs = computed(() => clampSeconds(autoRefreshSeconds.value) * 1000)
  return { autoRefreshEnabled, autoRefreshSeconds, autoRefreshIntervalMs }
}

/** 在调用方注册一个跟随共享开关的周期任务：默认关闭，开启后按设定秒数执行 tick。 */
export function useFarmAutoRefreshInterval(tick: () => void | Promise<void>) {
  const { autoRefreshEnabled, autoRefreshIntervalMs } = useFarmAutoRefresh()
  // useIntervalFn 不接管返回值：async tick 抛错会变成未处理的 Promise 拒绝，
  // 定时器还在跑、界面却再也不更新。这里统一兜住并留一条可查的日志。
  const safeTick = () => {
    try {
      const result = tick()
      if (result && typeof (result as Promise<void>).then === 'function')
        Promise.resolve(result).catch(error => console.error('[自动刷新] 周期任务执行失败', error))
    }
    catch (error) {
      console.error('[自动刷新] 周期任务执行失败', error)
    }
  }
  const { pause, resume } = useIntervalFn(safeTick, autoRefreshIntervalMs, { immediate: false })
  watch(autoRefreshEnabled, (on) => {
    if (on)
      resume()
    else
      pause()
  }, { immediate: true })
  return { pause, resume }
}
